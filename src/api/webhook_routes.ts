// Everything an EXTERNAL service calls on us (as opposed to every other *_routes.ts file, which our own
// client calls). Grouped together deliberately: OAuth callback (Google/Slack redirect the user's browser
// here after consent) and inbound trigger webhooks (a third party pushing an event to us) are the same
// *shape* of endpoint even though they serve different purposes — unauthenticated-by-us, provider-
// initiated, need their own verification per provider.
//
// Result page uses the same shared visual shell as the api_key connect form (src/lib/connectPage.ts) —
// so an oauth2 callback and an api_key connect end up looking like one product, not two.

import { connectionStore, triggerInstanceStore } from "../core/store";
import { getApp } from "../core/registry";
import { exchangeCodeForToken } from "../lib/oauth";
import { successPage, errorPage } from "../lib/connectPage";
import { verifySlackSignature } from "../lib/slackSignature";
import { deliverEvent } from "../core/scheduler";

interface SlackEventsApiBody {
  type: string; // "url_verification" | "event_callback" | ...
  challenge?: string; // only present for url_verification
  team_id?: string;
  event?: {
    type: string; // "message", "reaction_added", etc. — only "message" is handled
    subtype?: string;
    bot_id?: string;
    [key: string]: unknown;
  };
}

// Slack sends ONE Events API POST per app-level subscription — not per our TriggerInstance, not per our
// Connection. This resolves "which of our connections does this team_id belong to" and fans the event out
// to every active new_message TriggerInstance on that connection, reusing the exact same deliverEvent()
// the poll-based scheduler uses (src/core/scheduler.ts) — same envelope shape either way.
async function deliverSlackMessageEvent(teamId: string, rawEvent: NonNullable<SlackEventsApiBody["event"]>): Promise<void> {
  const app = getApp("slack");
  const trigger = app.triggers.find((t) => t.key === "new_message");
  if (!trigger?.handleWebhook) {
    return;
  }

  const connections = (await connectionStore.listAll()).filter(
    (c) => c.app === "slack" && c.status === "active" && c.secrets?.team_id === teamId,
  );
  if (connections.length === 0) {
    // No connection matches this workspace — nothing to deliver to. Not an error: could be a workspace
    // that installed the app but has no active TriggerInstance, or a stale/uninstalled connection.
    return;
  }

  const activeInstances = await triggerInstanceStore.listActive();

  for (const connection of connections) {
    const normalizedEvents = await trigger.handleWebhook(connection, rawEvent);
    const instances = activeInstances.filter((i) => i.connection_id === connection.connection_id && i.trigger_key === "new_message");
    for (const instance of instances) {
      for (const event of normalizedEvents) {
        await deliverEvent(instance, event);
      }
    }
  }
}

export const webhookRoutes = {
  "/oauth/callback/:app": {
    GET: async (req: Request & { params: { app: string } }) => {
      const url = new URL(req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state"); // connection_id
      const providerError = url.searchParams.get("error"); // e.g. user clicked "deny" on the consent screen

      if (providerError) {
        return errorPage(`Provider returned an error: ${providerError}`);
      }
      if (!code || !state) {
        return errorPage("Missing code or state in callback — this link may be malformed or already used.");
      }

      const connection = await connectionStore.get(state);
      if (!connection) {
        return errorPage("Unknown or expired connection — try connecting again.");
      }
      if (connection.app !== req.params.app) {
        // Defends against a state token being replayed against the wrong app's callback URL.
        return errorPage("App mismatch between the connect request and this callback.");
      }

      try {
        const app = getApp(req.params.app);
        if (app.auth.type !== "oauth2") {
          // This route only exists for oauth2 apps (api_key apps go straight to "active" in
          // connection_routes.ts, never through here) — reachable only if something hits this URL for the
          // wrong app, not a real flow.
          return errorPage(`App "${app.id}" doesn't use an OAuth callback (auth type: ${app.auth.type}).`);
        }
        const secrets = await exchangeCodeForToken(app.auth, app.id, code);
        await connectionStore.update(connection.connection_id, {
          status: "active",
          secrets,
          updated_at: new Date().toISOString(),
        });
        return successPage(app.name);
      } catch (err) {
        await connectionStore.update(connection.connection_id, {
          status: "error",
          updated_at: new Date().toISOString(),
        });
        return errorPage(err instanceof Error ? err.message : String(err));
      }
    },
  },

  // Real, per the fan-in model already leaned toward in docs/research/triggers-patterns.md — one Events
  // API subscription URL per app, not one per connection or trigger instance. Register this exact URL
  // (BASE_URL + /webhooks/slack/events) as the Request URL under Slack app config -> Event Subscriptions.
  //
  // Path is /webhooks/:app/events, consistent with the generic tool_slug-shaped paths elsewhere
  // (/actions/{tool_slug} etc.) even though Slack is the only app implementing this today — the body
  // parsing/verification below (SlackEventsApiBody, verifySlackSignature) is genuinely Slack-Events-API-
  // shaped, not a generic "webhook" concept, so it stays a per-app switch here rather than a speculative
  // hook on AppDefinition/TriggerDefinition invented from a single data point.
  "/webhooks/:app/events": {
    POST: async (req: Request & { params: { app: string } }) => {
      if (req.params.app !== "slack") {
        return new Response(`No webhook receiver for app "${req.params.app}".`, { status: 404 });
      }

      // Raw text, not req.json() — signature verification needs the EXACT bytes Slack signed; parsing to
      // JSON and re-stringifying would silently produce a different string and always fail verification.
      const rawBody = await req.text();

      let signatureValid: boolean;
      try {
        signatureValid = verifySlackSignature(rawBody, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"));
      } catch (err) {
        console.error("[webhooks] Slack signature verification misconfigured:", err);
        return new Response("Signature verification not configured", { status: 500 });
      }
      if (!signatureValid) {
        return new Response("Invalid signature", { status: 401 });
      }

      const body = JSON.parse(rawBody) as SlackEventsApiBody;

      if (body.type === "url_verification") {
        // Slack's own setup handshake, run once when you save the Request URL in their app config — echo
        // the challenge back plain, not wrapped in anything else.
        return Response.json({ challenge: body.challenge });
      }

      if (body.type !== "event_callback" || !body.event || body.event.type !== "message" || !body.team_id) {
        return new Response("ok"); // ack anything we don't handle — Slack retries on non-2xx
      }

      // Filter out bot/our-own messages — without this, our own post_message action (or any bot) would
      // loop straight back through this same trigger.
      if (body.event.subtype === "bot_message" || body.event.bot_id) {
        return new Response("ok");
      }

      // Fire-and-forget: Slack requires an ack within 3s, and webhook_url delivery to our subscribers is
      // a separate concern that must not block or fail this response.
      deliverSlackMessageEvent(body.team_id, body.event).catch((err) => console.error("[webhooks] Slack event delivery failed:", err));

      return new Response("ok");
    },
  },
};

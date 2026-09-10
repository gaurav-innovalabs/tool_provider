// Everything an EXTERNAL service calls on us (as opposed to every other *_routes.ts file, which our own
// client calls). Grouped together deliberately: OAuth callback (Google/Slack redirect the user's browser
// here after consent) and inbound trigger webhooks (a third party pushing an event to us) are the same
// *shape* of endpoint even though they serve different purposes — unauthenticated-by-us, provider-
// initiated, need their own verification per provider.
//
// Result page uses the same shared visual shell as the api_key connect form (src/lib/connectPage.ts) —
// so an oauth2 callback and an api_key connect end up looking like one product, not two.

import { connectionStore } from "../core/store";
import { getApp } from "../core/registry";
import { exchangeCodeForToken } from "../lib/oauth";
import { successPage, errorPage } from "../lib/connectPage";
import { formatError } from "../lib/errors";

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
        console.error("[oauth callback] failed:", err);
        await connectionStore.update(connection.connection_id, {
          status: "error",
          updated_at: new Date().toISOString(),
        });
        return errorPage(formatError(err));
      }
    },
  },

  // Generic inbound-webhook dispatcher — ONE route for every app/provider, not one hand-written route per
  // provider. `:hook` lets one app register more than one named receiver later (Slack has just "events"
  // today: POST /webhooks/slack/events) without a new top-level route. This handler has ZERO per-provider
  // knowledge on purpose — no signature verification, no event parsing, nothing Slack/Gmail/Stripe-shaped
  // lives here. It only looks up `AppDefinition.webhooks[hook]` (types.ts documents the field; see
  // src/components/slack/app.ts's `webhooks` block for the full request flow + how a new app plugs in) and
  // hands that handler the raw, unparsed Request — the app's own src/components/<app>/webhooks/<hook>.ts
  // owns everything from there (signature/HMAC verification, provider handshakes, mapping a raw payload to
  // a TriggerDefinition.key, fan-out via src/core/scheduler.ts's deliverEvent). Adding a webhook receiver
  // for a new app/provider is then a new sibling file + one `webhooks` map entry — never a change here.
  "/webhooks/:app/:hook": {
    POST: async (req: Request & { params: { app: string; hook: string } }) => {
      // Logged here, at the generic entry point, BEFORE dispatch — so every inbound webhook is visible
      // (including an unknown app/hook that 404s below) without relying on each provider-specific handler
      // to log it itself. Deeper per-event logging (e.g. which Slack event TYPE it was) lives in the
      // provider's own handler, e.g. src/components/slack/webhooks/events.ts.
      console.log(`[webhooks] received POST /webhooks/${req.params.app}/${req.params.hook}`);

      let app: ReturnType<typeof getApp>;
      try {
        app = getApp(req.params.app);
      } catch {
        console.warn(`[webhooks] 404: unknown app "${req.params.app}" — check the Request URL registered with the provider matches a real app slug.`);
        return new Response(`Unknown app "${req.params.app}"`, { status: 404 });
      }

      const handler = app.webhooks?.[req.params.hook];
      if (!handler) {
        console.warn(`[webhooks] 404: app "${app.id}" has no webhook receiver registered for hook "${req.params.hook}".`);
        return new Response(`No webhook receiver "${req.params.hook}" registered for app "${app.id}"`, { status: 404 });
      }

      // Every EXPECTED failure inside a handler already logs its own specific reason (missing/invalid
      // signature, bad JSON, etc. — see e.g. slackSignature.ts). This catches the unexpected case: a real
      // bug, a downstream call throwing, anything the handler's own code didn't anticipate — so THAT still
      // gets a labeled log line here instead of silently becoming a generic Bun error with no
      // "[webhooks]"-tagged trace back to which provider/hook it came from.
      try {
        return await handler(req);
      } catch (err) {
        console.error(`[webhooks] ${app.id}/${req.params.hook} handler threw an unexpected error:`, err);
        return new Response("Internal error handling webhook", { status: 500 });
      }
    },
  },
};

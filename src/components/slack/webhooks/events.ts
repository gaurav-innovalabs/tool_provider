// Slack's Events API receiver — the ONE handler Slack actually calls, registered as this app's "events"
// webhook (see ../app.ts's `webhooks` map) and reached generically via POST /webhooks/slack/events
// (src/api/webhook_routes.ts just looks up AppDefinition.webhooks["events"] and hands it the raw Request —
// it has no Slack-specific knowledge at all). Everything Slack-Events-API-shaped — signature verification,
// the url_verification handshake, mapping a raw event to one of our TriggerDefinition.key values, and
// fanning the normalized event out to every subscribed TriggerInstance — lives in this one file, so a
// future app with its own webhook shape (Gmail push via Pub/Sub, Stripe, whatever) is a same-shaped
// sibling file (src/components/<app>/webhooks/<name>.ts) plus one entry in that app's `webhooks` map,
// never a change to webhook_routes.ts itself.

import { connectionStore, triggerInstanceStore } from "../../../core/store";
import { getApp } from "../../../core/registry";
import { verifySlackSignature } from "../../../lib/slackSignature";
import { deliverEvent } from "../../../core/scheduler";

interface SlackEventsApiBody {
  type: string; // "url_verification" | "event_callback" | ...
  challenge?: string; // only present for url_verification
  team_id?: string;
  event?: {
    type: string; // "message", "reaction_added", "member_joined_channel", "channel_created", ...
    subtype?: string;
    bot_id?: string;
    [key: string]: unknown;
  };
}

// Maps a raw Slack event's (type, subtype) to one of our TriggerDefinition.key values (see
// ../app.ts's `triggers` array for the full list) — the one place that knows Slack's event-shape quirk
// where several distinct trigger keys (new_message, message_edited, message_deleted) all arrive as the
// same top-level `message` event type, distinguished only by `subtype`. Every other event type here maps
// 1:1 to its own trigger key.
function resolveTriggerKey(event: NonNullable<SlackEventsApiBody["event"]>): string | null {
  if (event.type === "message") {
    if (!event.subtype) return "new_message";
    if (event.subtype === "message_changed") return "message_edited";
    if (event.subtype === "message_deleted") return "message_deleted";
    return null; // other message subtypes (e.g. channel_join system messages) — nothing listens for these yet
  }
  if (event.type === "reaction_added") return "reaction_added";
  if (event.type === "reaction_removed") return "reaction_removed";
  if (event.type === "member_joined_channel") return "user_joined_channel";
  if (event.type === "channel_created") return "channel_created";
  if (event.type === "file_shared") return "file_shared";
  return null;
}

// Slack sends ONE Events API POST per app-level subscription — not per our TriggerInstance, not per our
// Connection. This resolves "which of our connections does this team_id belong to" and fans the event out
// to every active TriggerInstance (for the resolved trigger key) on that connection whose own
// TriggerInstance.config — the per-instance input props set at subscribe time, e.g. { channel } / {
// channel, thread_ts } — actually matches this event (via the trigger's own matchesConfig, types.ts), so a
// caller who scoped new_message to #test-user never gets events from other channels. Reuses the exact same
// deliverEvent() the poll-based scheduler uses (src/core/scheduler.ts) — same envelope shape either way.
async function deliverSlackEvent(teamId: string, triggerKey: string, rawEvent: NonNullable<SlackEventsApiBody["event"]>): Promise<void> {
  const app = getApp("slack");
  const trigger = app.triggers.find((t) => t.key === triggerKey);
  if (!trigger?.handleWebhook) {
    return;
  }

  const connections = (await connectionStore.listAll()).filter(
    (c) => c.app === "slack" && c.status === "active" && c.secrets?.team_id === teamId,
  );
  if (connections.length === 0) {
    // No connection matches this workspace — nothing to deliver to. Not an error: could be a workspace
    // that installed the app but has no active TriggerInstance, or a stale/uninstalled connection. Logged
    // (not silent) because this is exactly what you'd see if a connection was revoked/expired without
    // realizing it, or Slack delivered an event for a team_id that genuinely has no matching connection.
    console.log(`[webhooks] slack event: no active slack connection matches team_id=${teamId} — nothing to deliver to`);
    return;
  }

  const activeInstances = await triggerInstanceStore.listActive();

  for (const connection of connections) {
    const normalizedEvents = await trigger.handleWebhook(connection, rawEvent);
    const candidateInstances = activeInstances.filter((i) => i.connection_id === connection.connection_id && i.trigger_key === triggerKey);
    // config === null means an unscoped subscription (fires for everything on this trigger_key) — only
    // run matchesConfig when the instance actually declared one. A trigger with no matchesConfig at all
    // (channel_created) never filters, regardless of what a caller passed at subscribe time.
    const instances = candidateInstances.filter((i) => i.config == null || !trigger.matchesConfig || trigger.matchesConfig(rawEvent, i.config));
    if (candidateInstances.length === 0) {
      console.log(`[webhooks] slack event: connection_id=${connection.connection_id} has no active "${triggerKey}" subscription — nothing to deliver to`);
    } else if (instances.length === 0) {
      // Every subscription's config (e.g. channel_id) rejected this specific event — the #1 cause of
      // "I subscribed and it just never fires with no error anywhere". Logged with the actual configs so
      // it's immediately obvious whether it's a real mismatch (wrong channel_id) vs. something else.
      console.log(
        `[webhooks] slack event: ${candidateInstances.length} "${triggerKey}" subscription(s) on connection_id=${connection.connection_id}, but none matched this event's config filter — instance configs: ${candidateInstances.map((i) => JSON.stringify(i.config)).join(", ")}`,
      );
    }
    for (const instance of instances) {
      for (const event of normalizedEvents) {
        await deliverEvent(instance, event);
      }
    }
  }
}

// Real, per the fan-in model already leaned toward in docs/research/triggers-patterns.md — one Events API
// subscription URL per app, not one per connection or trigger instance. Register this exact URL
// (BASE_URL + /webhooks/slack/events) as the Request URL under Slack app config -> Event Subscriptions
// (see .env.example's SLACK_SIGNING_SECRET comment for the full click-path).
export async function handleSlackEventsWebhook(req: Request): Promise<Response> {
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

  let body: SlackEventsApiBody;
  try {
    body = JSON.parse(rawBody) as SlackEventsApiBody;
  } catch (err) {
    // Signature verified but the body isn't valid JSON — shouldn't happen for a real Slack request, but
    // previously this threw uncaught with zero log line, a 500 with no explanation. Now it's diagnosable.
    console.error("[webhooks] Slack event body failed to parse as JSON despite a valid signature:", err);
    return new Response("Invalid JSON body", { status: 400 });
  }
  // Every inbound Slack Events API POST that passes signature verification, logged with enough to trace it
  // through the rest of this function — body.type (url_verification vs. event_callback vs. anything else
  // Slack might send), and for event_callback the nested event's own (type, subtype) since that's what
  // resolveTriggerKey below actually dispatches on.
  console.log(
    `[webhooks] slack event: type=${body.type}` +
      (body.event ? ` event.type=${body.event.type}${body.event.subtype ? ` subtype=${body.event.subtype}` : ""}` : ""),
  );

  if (body.type === "url_verification") {
    // Slack's own setup handshake, run once when you save the Request URL in their app config — echo
    // the challenge back plain, not wrapped in anything else.
    return Response.json({ challenge: body.challenge });
  }

  if (body.type !== "event_callback" || !body.event || !body.team_id) {
    console.log(`[webhooks] slack event: acked, not handled (type=${body.type}, has event=${!!body.event}, has team_id=${!!body.team_id})`);
    return new Response("ok"); // ack anything we don't handle — Slack retries on non-2xx
  }

  // Filter out bot/our-own messages — without this, our own post_message action (or any bot) would
  // loop straight back through the new_message/message_edited/message_deleted triggers. Irrelevant to
  // non-message event types (reactions, channel/member events), which carry neither field.
  if (body.event.subtype === "bot_message" || body.event.bot_id) {
    console.log(`[webhooks] slack event: skipped (bot/own message) team_id=${body.team_id}`);
    return new Response("ok");
  }

  const triggerKey = resolveTriggerKey(body.event);
  if (!triggerKey) {
    console.log(`[webhooks] slack event: no trigger registered for event.type=${body.event.type}${body.event.subtype ? `/${body.event.subtype}` : ""} — ignored`);
    return new Response("ok"); // no trigger registered for this event shape yet
  }
  console.log(`[webhooks] slack event: resolved to trigger_key=${triggerKey} team_id=${body.team_id}`);

  // Fire-and-forget: Slack requires an ack within 3s, and webhook_url delivery to our subscribers is
  // a separate concern that must not block or fail this response.
  deliverSlackEvent(body.team_id, triggerKey, body.event).catch((err) => console.error("[webhooks] Slack event delivery failed:", err));

  return new Response("ok");
}

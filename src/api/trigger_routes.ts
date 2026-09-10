// Trigger *subscription management* — client-facing (client asks us to start/stop watching something,
// and to see what's watchable in the first place). Actual event delivery — src/core/scheduler.ts polling
// each active instance and POSTing to its webhook_url — lives there, not here; this file only manages the
// subscription records.

import { z } from "zod";
import { connectionStore, triggerInstanceStore, triggerLogStore } from "../core/store";
import { getApp, listApps } from "../core/registry";
import { resendDelivery } from "../core/scheduler";

// No global poll interval — matches Pipedream (per-source `timer` prop, its own default) and Composio
// (per-trigger `trigger_config.interval`), both verified from real source/docs. `poll_interval_ms` here
// is optional: omit it to use the trigger's own defaultPollIntervalMs (types.ts).
const MIN_POLL_INTERVAL_MS = 60 * 1000; // floor against an absurd value hammering the provider — lenient
// compared to Composio's real 15-min minimum (their docs, 2026-03-11 changelog) since we're not sharing
// rate limits across many tenants the way they are; revisit if that ever becomes true here too.

// TODO(ask): 4096 bytes (JSON.stringify size) is a guess, not a confirmed spec number — nearest real-world
// reference point was Stripe's metadata limits (50 keys, 500 chars/value), not an exact match for a single
// opaque blob like this one. Confirm the number, and whether Connection.extra_metadata (POST /connections,
// currently unbounded) should get the same cap for consistency — see types.ts's TriggerInstance.extra_metadata.
const MAX_EXTRA_METADATA_BYTES = 4096;

const extraMetadataSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= MAX_EXTRA_METADATA_BYTES, {
    message: `extra_metadata must serialize to ${MAX_EXTRA_METADATA_BYTES} bytes or fewer`,
  })
  .optional();

const subscribeBody = z.object({
  connection_id: z.string(),
  // "we will call the user webhook_url when we receive any trigger" — required per subscription, not a
  // separate project-wide resource (see types.ts's TriggerInstance.webhook_url comment for why).
  webhook_url: z.string().url(),
  // Optional override of the trigger's own defaultPollIntervalMs. Ignored for webhook-mode triggers
  // (Slack) — they never poll at all.
  poll_interval_ms: z.number().int().min(MIN_POLL_INTERVAL_MS).optional(),
  // Opaque client space — e.g. { notes: "..." }. Never read/interpreted by us. See types.ts's
  // TriggerInstance.extra_metadata and MAX_EXTRA_METADATA_BYTES above.
  extra_metadata: extraMetadataSchema,
});

const updateMetadataBody = z.object({
  extra_metadata: extraMetadataSchema.unwrap(), // required on PATCH — omitting the body makes no sense for a metadata-only update route
});

const resendBody = z.object({
  // No session-bound identity on the REST surface (unlike MCP's per-session userId) — same ownership-check
  // pattern GET /triggers/instances and GET /connections already use: the caller states who they are, we
  // verify it against the row before acting, same trust model as the rest of this bearer-token-gated API.
  user_id: z.string(),
});

export const triggerRoutes = {
  // Mirrors src/openapi.ts's actionPaths() pattern — derived from the registry, not hand-maintained, so
  // it can't list a trigger that doesn't actually exist in code.
  "/triggers": {
    GET: async () => {
      const triggers = listApps().flatMap((app) =>
        app.triggers.map((t) => ({
          app: app.id,
          key: t.key,
          description: t.description,
          mode: t.mode,
          default_poll_interval_ms: t.defaultPollIntervalMs ?? null,
          // JSON Schema of the `data` object this trigger delivers to a subscriber's webhook_url — null
          // when the trigger hasn't declared one yet (TriggerDefinition.payload is optional).
          payload: t.payload ? z.toJSONSchema(t.payload) : null,
        })),
      );
      return Response.json(triggers);
    },
  },

  "/triggers/:app/:trigger/subscribe": {
    POST: async (req: Request & { params: { app: string; trigger: string } }) => {
      try {
        const body = subscribeBody.parse(await req.json());
        const app = getApp(req.params.app); // throws on unknown app — caught below as a 500; matches connection_routes.ts's existing TODO
        const trigger = app.triggers.find((t) => t.key === req.params.trigger);
        if (!trigger) {
          return Response.json({ error: `Unknown trigger: ${req.params.app}.${req.params.trigger}` }, { status: 404 });
        }

        const connection = await connectionStore.get(body.connection_id);
        if (!connection) {
          return Response.json({ error: `Unknown connection: ${body.connection_id}` }, { status: 404 });
        }
        if (connection.app !== req.params.app) {
          return Response.json({ error: `Connection ${body.connection_id} is for app "${connection.app}", not "${req.params.app}"` }, { status: 400 });
        }
        if (connection.status !== "active") {
          return Response.json({ error: `Connection ${body.connection_id} is not active (status: ${connection.status})` }, { status: 409 });
        }

        // Resolved ONCE here, per-instance — not a global setting. Poll-mode only; webhook-mode triggers
        // (Slack) never poll, so this stays null for them regardless of what was requested.
        const poll_interval_ms = trigger.mode === "poll" ? (body.poll_interval_ms ?? trigger.defaultPollIntervalMs ?? null) : null;

        const trigger_instance_id = `ti_${crypto.randomUUID()}`;
        const now = new Date().toISOString();
        await triggerInstanceStore.create({
          trigger_instance_id,
          connection_id: connection.connection_id,
          user_id: connection.user_id,
          app: req.params.app,
          trigger_key: req.params.trigger,
          status: "active",
          webhook_url: body.webhook_url,
          poll_interval_ms,
          cursor: null, // seeded on the scheduler's first poll of this instance, not here — see each trigger's poll() "if (!cursor)" branch
          extra_metadata: body.extra_metadata ?? {},
          created_at: now,
          updated_at: now,
        });

        return Response.json({ trigger_instance_id, status: "active", poll_interval_ms }, { status: 201 });
      } catch (err) {
        const status = err instanceof z.ZodError ? 400 : 500;
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
      }
    },
  },

  // Client-facing "which triggers have I actually subscribed to" — distinct from GET /triggers above
  // (available trigger TYPES, not instances). Named as its own sub-path, not a query param on /triggers,
  // so it can't collide with a future path-param trigger lookup there. `user_id` required (this is a
  // client-facing list-mine route, not an admin one — GET /admin/triggers already covers "every instance,
  // every user"); optional `app` narrows further.
  "/triggers/instances": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const user_id = url.searchParams.get("user_id");
      if (!user_id) {
        return Response.json({ error: "user_id query param is required" }, { status: 400 });
      }
      const app = url.searchParams.get("app") ?? undefined;
      const instances = await triggerInstanceStore.listByUser(user_id, app);
      return Response.json({ trigger_instances: instances });
    },
  },

  // Client-facing "what has this trigger actually done" — status/webhook_url/history per run, Stripe-CLI-
  // `events list`-style. Distinct 3-segment path (not a query param or a sub-resource of /triggers/:id) so
  // it can't collide with /triggers/:id's own routes below — same discipline as /triggers/instances vs
  // /triggers/:id. `user_id` required and checked against the instance's own owner (same 404-not-403 idiom
  // as everywhere else here — don't reveal whether an instance exists to a non-owner).
  "/triggers/instances/:id/logs": {
    GET: async (req: Request & { params: { id: string } }) => {
      const url = new URL(req.url);
      const user_id = url.searchParams.get("user_id");
      if (!user_id) {
        return Response.json({ error: "user_id query param is required" }, { status: 400 });
      }
      const instance = await triggerInstanceStore.get(req.params.id);
      if (!instance || instance.user_id !== user_id) {
        return Response.json({ error: `Unknown trigger instance: ${req.params.id}` }, { status: 404 });
      }
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const logs = await triggerLogStore.listByInstance(req.params.id, limit);
      return Response.json({
        trigger_instance: { trigger_instance_id: instance.trigger_instance_id, status: instance.status, webhook_url: instance.webhook_url },
        logs: logs.map((l) => ({
          log_id: l.log_id,
          status: l.status,
          ran_at: l.ran_at,
          error: l.error,
          webhook_url: l.webhook_url,
          // `resendable` spares the caller from having to know "presence of payload is the signal" —
          // POST /triggers/logs/{id}/resend will 400 on a log_id where this is false.
          resendable: l.payload !== undefined,
        })),
      });
    },
  },

  // ~ Stripe's `GET /v1/events/{id}`: pass the `evt_...` id from any list_trigger_logs/logs-list entry (or
  // handed to you out-of-band) and get that one event's full body back — including `payload`, which the
  // list route deliberately omits (see GET /triggers/instances/:id/logs above). `log_id` IS the event id
  // for a delivery row (scheduler.ts's deliverEvent/resendDelivery generate one id, used as both) — this is
  // the one place to actually re-read an event's `data` after the fact instead of re-deriving it.
  "/triggers/logs/:log_id": {
    GET: async (req: Request & { params: { log_id: string } }) => {
      const url = new URL(req.url);
      const user_id = url.searchParams.get("user_id");
      if (!user_id) {
        return Response.json({ error: "user_id query param is required" }, { status: 400 });
      }
      const log = await triggerLogStore.get(req.params.log_id);
      if (!log || log.user_id !== user_id) {
        return Response.json({ error: `Unknown trigger log: ${req.params.log_id}` }, { status: 404 });
      }
      return Response.json({
        log_id: log.log_id,
        trigger_instance_id: log.trigger_instance_id,
        app: log.app,
        trigger_key: log.trigger_key,
        status: log.status,
        ran_at: log.ran_at,
        error: log.error,
        webhook_url: log.webhook_url,
        payload: log.payload,
        resendable: log.payload !== undefined,
      });
    },
  },

  // Stripe-CLI-`events resend`-style: re-POST an already-captured delivery's exact payload (same event id/
  // timestamp — a resend of that event, not a new one) to the trigger instance's CURRENT webhook_url. Only
  // resendable rows (payload captured — every deliverEvent() row since the extra_metadata/logs pass; not
  // poll-ATTEMPT rows, which never had a payload) can be replayed. See src/core/scheduler.ts's
  // resendDelivery() for the actual re-POST + new-log-row mechanics.
  "/triggers/logs/:log_id/resend": {
    POST: async (req: Request & { params: { log_id: string } }) => {
      try {
        const body = resendBody.parse(await req.json());
        const log = await triggerLogStore.get(req.params.log_id);
        if (!log || log.user_id !== body.user_id) {
          return Response.json({ error: `Unknown trigger log: ${req.params.log_id}` }, { status: 404 });
        }
        if (log.payload === undefined) {
          return Response.json({ error: `Trigger log ${req.params.log_id} has no captured payload to resend (a poll-attempt row, not a delivery).` }, { status: 400 });
        }
        const instance = await triggerInstanceStore.get(log.trigger_instance_id);
        if (!instance) {
          return Response.json({ error: `Trigger instance ${log.trigger_instance_id} no longer exists.` }, { status: 404 });
        }
        const resent = await resendDelivery(instance, log.payload);
        return Response.json({ log_id: resent.log_id, status: resent.status, ran_at: resent.ran_at, webhook_url: resent.webhook_url, error: resent.error }, { status: 201 });
      } catch (err) {
        const status = err instanceof z.ZodError ? 400 : 500;
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
      }
    },
  },

  "/triggers/:id": {
    DELETE: async (req: Request & { params: { id: string } }) => {
      const instance = await triggerInstanceStore.get(req.params.id);
      if (!instance) {
        return Response.json({ error: `Unknown trigger instance: ${req.params.id}` }, { status: 404 });
      }
      await triggerInstanceStore.delete(req.params.id);
      return Response.json({ deleted: true });
    },

    // Metadata-only update — the client's own notes/tags space, editable after subscribe time (unlike
    // Connection.extra_metadata, which is write-once at POST /connections). Everything else about a
    // TriggerInstance (webhook_url, poll_interval_ms, ...) is immutable post-subscribe by design: delete +
    // re-subscribe is the only way to change those, same as Phase 3's documented trigger-pause gap.
    PATCH: async (req: Request & { params: { id: string } }) => {
      try {
        const instance = await triggerInstanceStore.get(req.params.id);
        if (!instance) {
          return Response.json({ error: `Unknown trigger instance: ${req.params.id}` }, { status: 404 });
        }
        const body = updateMetadataBody.parse(await req.json());
        await triggerInstanceStore.update(req.params.id, { extra_metadata: body.extra_metadata, updated_at: new Date().toISOString() });
        return Response.json({ trigger_instance_id: req.params.id, extra_metadata: body.extra_metadata });
      } catch (err) {
        const status = err instanceof z.ZodError ? 400 : 500;
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
      }
    },
  },
};

// Trigger *subscription management* — client-facing (client asks us to start/stop watching something,
// and to see what's watchable in the first place). Actual event delivery — src/core/scheduler.ts polling
// each active instance and POSTing to its webhook_url — lives there, not here; this file only manages the
// subscription records.

import { z } from "zod";
import { connectionStore, triggerInstanceStore } from "../core/store";
import { getApp, listApps } from "../core/registry";

// No global poll interval — matches Pipedream (per-source `timer` prop, its own default) and Composio
// (per-trigger `trigger_config.interval`), both verified from real source/docs. `poll_interval_ms` here
// is optional: omit it to use the trigger's own defaultPollIntervalMs (types.ts).
const MIN_POLL_INTERVAL_MS = 60 * 1000; // floor against an absurd value hammering the provider — lenient
// compared to Composio's real 15-min minimum (their docs, 2026-03-11 changelog) since we're not sharing
// rate limits across many tenants the way they are; revisit if that ever becomes true here too.

const subscribeBody = z.object({
  connection_id: z.string(),
  // "we will call the user webhook_url when we receive any trigger" — required per subscription, not a
  // separate project-wide resource (see types.ts's TriggerInstance.webhook_url comment for why).
  webhook_url: z.string().url(),
  // Optional override of the trigger's own defaultPollIntervalMs. Ignored for webhook-mode triggers
  // (Slack) — they never poll at all.
  poll_interval_ms: z.number().int().min(MIN_POLL_INTERVAL_MS).optional(),
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

  "/triggers/:id": {
    DELETE: async (req: Request & { params: { id: string } }) => {
      const instance = await triggerInstanceStore.get(req.params.id);
      if (!instance) {
        return Response.json({ error: `Unknown trigger instance: ${req.params.id}` }, { status: 404 });
      }
      await triggerInstanceStore.delete(req.params.id);
      return Response.json({ deleted: true });
    },
  },
};

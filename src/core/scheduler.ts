// The piece that was missing from every earlier trigger discussion: something that actually CALLS
// poll(). Delivers new events to each instance's webhook_url — "we will call the user webhook_url when
// we receive any trigger, just like Composio."
//
// NO global poll interval. Verified from real source (not guessed): Pipedream's actual published
// @pipedream/platform package declares `DEFAULT_POLLING_SOURCE_TIMER_INTERVAL = 60 * 15` (15 min) as a
// PER-SOURCE prop default, user-overridable per deployed instance — not one setting applied to every
// trigger. Composio's trigger_config takes a per-trigger `interval` too (with a 15-min minimum as of their
// 2026-03-11 changelog). This file follows the same shape: each TriggerInstance carries its OWN resolved
// `poll_interval_ms` (src/api/trigger_routes.ts, from the trigger's defaultPollIntervalMs or an explicit
// override). SCHEDULER_TICK_MS below is a different thing entirely — just how often this process checks
// "is anything due yet", an internal implementation detail, never a per-trigger cadence.
//
// Envelope shape deliberately mirrors Composio's real webhook payload (confirmed from their docs during
// R&D, see research/triggers-patterns.md): { id, type, metadata: {...}, data, timestamp }.
//
// TODO(ask): no delivery signing yet (Nango/Composio both HMAC-sign outbound webhooks, per
// research/triggers-patterns.md's "Outbound webhook delivery hardening" section) — a receiver currently
// has no way to verify a POST actually came from us. Worth adding before this is used for anything beyond
// local testing.
// No retry/circuit-breaker on delivery failure, by explicit decision ("no need to retry at all, just
// failed ok") — a failed POST to webhook_url is recorded in trigger_logs as status "error" and left alone,
// not retried. trigger_logs (src/db/schema.ts) is the audit trail for every poll attempt and delivery
// attempt, poll or webhook mode alike — see deliverEvent() and runTriggerPollCycle() below.
// Single-process setInterval by design — only one worker process runs at a time (see worker.ts), so no
// per-instance locking is needed here.

import { triggerInstanceStore, connectionStore, triggerLogStore } from "./store";
import { getApp } from "./registry";
import { ensureFreshConnection } from "./tokenRefresh";
import type { TriggerInstance } from "../types";

// How often this process checks whether anything is due — NOT a poll interval, just loop granularity.
// 2 min, per spec: "after every 2 min -> check all triggers last_run > 8 min do run it." An instance
// whose own poll_interval_ms just elapsed gets picked up within 2 min, not exactly on the second.
const SCHEDULER_TICK_MS = 2 * 60 * 1000;

function isDue(instance: TriggerInstance): boolean {
  if (instance.poll_interval_ms == null) {
    return false; // webhook-mode trigger, or somehow created without an interval — never polled
  }
  if (instance.cursor === null || instance.cursor === undefined) {
    // Never polled yet — seed the cursor on the very next tick rather than waiting a full interval, same
    // reasoning as every trigger's own "if (!cursor)" seed branch: get it watching promptly, don't emit a
    // backlog.
    return true;
  }
  const elapsedMs = Date.now() - new Date(instance.updated_at).getTime();
  return elapsedMs >= instance.poll_interval_ms;
}

// Exported for direct testing — proving delivery works against a real HTTP receiver doesn't require a
// real Gmail/Slack success case to get there. Every attempt (success or failure) writes one row to
// trigger_logs — no retry, that row is the whole story.
export async function deliverEvent(webhookUrl: string, triggerSlug: string, triggerInstanceId: string, connectionId: string, userId: string, app: string, data: unknown): Promise<void> {
  const triggerKey = triggerSlug.startsWith(`${app}.`) ? triggerSlug.slice(app.length + 1) : triggerSlug;
  const envelope = {
    id: `evt_${crypto.randomUUID()}`,
    type: "trigger.message",
    metadata: {
      trigger_slug: triggerSlug,
      trigger_instance_id: triggerInstanceId,
      connection_id: connectionId,
      user_id: userId,
      app,
    },
    data,
    timestamp: new Date().toISOString(),
  };

  let status: "success" | "error" = "success";
  let error: string | undefined;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) {
      status = "error";
      error = `HTTP ${res.status}`;
      console.error(`[scheduler] webhook delivery to ${webhookUrl} failed (${res.status}) for trigger_instance ${triggerInstanceId}`);
    }
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] webhook delivery to ${webhookUrl} threw for trigger_instance ${triggerInstanceId}:`, err);
  }

  await triggerLogStore.append({
    log_id: `tlog_${crypto.randomUUID()}`,
    trigger_instance_id: triggerInstanceId,
    connection_id: connectionId,
    user_id: userId,
    app,
    trigger_key: triggerKey,
    status,
    ran_at: new Date().toISOString(),
    error,
  });
}

// One row per poll ATTEMPT (distinct from deliverEvent's per-event delivery rows) — records that the
// trigger ran at all, even when it produced zero events. No retry here either, same reasoning as deliverEvent.
async function logPollRun(instance: TriggerInstance, status: "success" | "error", error?: string): Promise<void> {
  await triggerLogStore.append({
    log_id: `tlog_${crypto.randomUUID()}`,
    trigger_instance_id: instance.trigger_instance_id,
    connection_id: instance.connection_id,
    user_id: instance.user_id,
    app: instance.app,
    trigger_key: instance.trigger_key,
    status,
    ran_at: new Date().toISOString(),
    error,
  });
}

export async function runTriggerPollCycle(): Promise<void> {
  const dueInstances = (await triggerInstanceStore.listActive()).filter(isDue);

  await Promise.all(
    dueInstances.map(async (instance) => {
      try {
        const app = getApp(instance.app);
        const trigger = app.triggers.find((t) => t.key === instance.trigger_key);
        if (!trigger || trigger.mode !== "poll" || !trigger.poll) {
          console.error(`[scheduler] trigger_instance ${instance.trigger_instance_id} references a non-pollable trigger (${instance.app}.${instance.trigger_key}) — skipping`);
          await logPollRun(instance, "error", "trigger is not pollable (missing/wrong mode)");
          return;
        }

        let connection = await connectionStore.get(instance.connection_id);
        if (!connection || connection.status !== "active") {
          console.error(`[scheduler] trigger_instance ${instance.trigger_instance_id}'s connection is missing/inactive — skipping`);
          await logPollRun(instance, "error", "connection missing/inactive");
          return;
        }
        // Refresh-ahead-of-expiry (src/core/tokenRefresh.ts) before every poll — same as action_routes.ts
        // does before every action call. A refresh failure throws and is caught below, same as any other
        // poll failure.
        connection = await ensureFreshConnection(app, connection);

        const { events, nextCursor } = await trigger.poll(connection, instance.cursor);

        for (const event of events) {
          await deliverEvent(instance.webhook_url, `${instance.app}.${instance.trigger_key}`, instance.trigger_instance_id, instance.connection_id, instance.user_id, instance.app, event);
        }

        await triggerInstanceStore.update(instance.trigger_instance_id, {
          cursor: nextCursor,
          status: "active",
          updated_at: new Date().toISOString(),
        });
        await logPollRun(instance, "success");
      } catch (err) {
        // One trigger instance failing (e.g. a revoked token) must not take down the whole poll cycle —
        // mark just that instance as errored and move on; every other instance still gets its turn.
        console.error(`[scheduler] poll failed for trigger_instance ${instance.trigger_instance_id}:`, err);
        await logPollRun(instance, "error", err instanceof Error ? err.message : String(err));
        await triggerInstanceStore.update(instance.trigger_instance_id, {
          status: "error",
          updated_at: new Date().toISOString(),
        });
      }
    }),
  );
}

export function startScheduler(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    runTriggerPollCycle().catch((err) => console.error("[scheduler] poll cycle threw:", err));
  }, SCHEDULER_TICK_MS);
}

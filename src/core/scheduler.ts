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
// R&D, see docs/research/triggers-patterns.md): { id, type, metadata: {...}, data, timestamp }. `type` is the
// actual trigger slug (e.g. "gmail.new_email") — the real dispatch key a receiver switches on, same as
// Stripe's `event.type` (e.g. "invoice.paid") — not a fixed placeholder string every trigger shares.
// `metadata` carries trigger_instance_id/connection_id/user_id/app PLUS the instance's own `extra_metadata`
// (the client's opaque notes space, set at subscribe time or edited via PATCH /triggers/:id) — echoed back
// on every delivery, same idea as Stripe echoing an object's `metadata` on its webhook events, so a
// receiver can route/identify without calling back into this API.
//
// TODO(ask): no delivery signing yet (Nango/Composio both HMAC-sign outbound webhooks, per
// docs/research/triggers-patterns.md's "Outbound webhook delivery hardening" section) — a receiver currently
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
import { formatError } from "../lib/errors";
import type { TriggerInstance, TriggerLogEntry } from "../types";

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
//
// Takes the full `instance` (not separate app/connection_id/user_id/... params — every call site already
// has it in hand) so the delivered envelope can echo back `instance.extra_metadata`, the same "client's own
// space, we never interpret it, we just hand it back to you" contract Stripe's webhook events follow for
// object metadata — the receiving endpoint can use it to route/identify without a lookup back to us.
export async function deliverEvent(instance: TriggerInstance, data: unknown): Promise<void> {
  // ONE id for both the envelope's own `id` (what the receiver sees) and this row's `log_id` (what
  // GET /triggers/logs/{id} and POST /triggers/logs/{id}/resend key off of) — no separate internal
  // row-id vs. external event-id to keep in sync. `evt_...` (not `tlog_...`) since this IS the event id,
  // Stripe-`evt_...`-shaped: pass the id back from any delivery you were shown and you get the same row.
  const id = `evt_${crypto.randomUUID()}`;
  const envelope = {
    id,
    type: `${instance.app}.${instance.trigger_key}`, // the dispatch key, e.g. "gmail.new_email" — see header comment
    metadata: {
      trigger_instance_id: instance.trigger_instance_id,
      connection_id: instance.connection_id,
      user_id: instance.user_id,
      app: instance.app,
      extra_metadata: instance.extra_metadata,
    },
    data,
    timestamp: new Date().toISOString(),
  };

  let status: "success" | "error" = "success";
  let error: string | undefined;
  try {
    const res = await fetch(instance.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) {
      status = "error";
      error = `HTTP ${res.status}`;
      console.error(`[scheduler] webhook delivery to ${instance.webhook_url} failed (${res.status}) for trigger_instance ${instance.trigger_instance_id}`);
    } else {
      // Success was previously silent — the only way to know a delivery actually landed was to query
      // trigger_logs yourself. Logged now so "did my event actually go out" is answerable from the
      // terminal alone, same as the failure path already was.
      console.log(`[scheduler] webhook delivery to ${instance.webhook_url} succeeded for trigger_instance ${instance.trigger_instance_id} (${envelope.type})`);
    }
  } catch (err) {
    status = "error";
    error = formatError(err);
    console.error(`[scheduler] webhook delivery to ${instance.webhook_url} threw for trigger_instance ${instance.trigger_instance_id}:`, err);
  }

  await triggerLogStore.append({
    log_id: id,
    trigger_instance_id: instance.trigger_instance_id,
    connection_id: instance.connection_id,
    user_id: instance.user_id,
    app: instance.app,
    trigger_key: instance.trigger_key,
    status,
    ran_at: new Date().toISOString(),
    error,
    // Stored regardless of success/failure — a failed delivery is exactly the case someone wants to
    // resend once the receiving endpoint is fixed, same as Stripe's dashboard showing failed deliveries
    // with a "Resend" button. See trigger_routes.ts's GET/POST /triggers/logs/{id}(/resend).
    webhook_url: instance.webhook_url,
    payload: envelope,
  });
}

// Stripe-CLI-`events resend`-style replay: re-POSTs an ALREADY-CAPTURED envelope BYTE-FOR-BYTE (same
// embedded event `id`/`timestamp` as the original — this is a resend of that event's content, not a new
// event) to the trigger instance's CURRENT webhook_url, which may differ from the log row's own stored
// `webhook_url` if it's been updated since — same intent as PHASES.md Phase 3's original resend note
// ("re-POST to the instance's CURRENT webhook_url"). Writes its OWN new trigger_logs row — a new delivery
// ATTEMPT gets its own `evt_...` id (same scheme as deliverEvent), even though the payload it carries still
// embeds the original event's id — so this attempt is itself independently resendable, and shows up in the
// instance's history alongside the original. Caller (trigger_routes.ts) is responsible for the ownership
// check and for confirming the source log actually has a `payload` to resend in the first place.
export async function resendDelivery(instance: TriggerInstance, payload: unknown): Promise<TriggerLogEntry> {
  let status: "success" | "error" = "success";
  let error: string | undefined;
  try {
    const res = await fetch(instance.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      status = "error";
      error = `HTTP ${res.status}`;
    }
  } catch (err) {
    status = "error";
    error = formatError(err);
  }

  const logEntry: TriggerLogEntry = {
    log_id: `evt_${crypto.randomUUID()}`,
    trigger_instance_id: instance.trigger_instance_id,
    connection_id: instance.connection_id,
    user_id: instance.user_id,
    app: instance.app,
    trigger_key: instance.trigger_key,
    status,
    ran_at: new Date().toISOString(),
    error,
    webhook_url: instance.webhook_url,
    payload,
  };
  await triggerLogStore.append(logEntry);
  return logEntry;
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

  // Previously this whole function logged NOTHING when every due instance polled cleanly and found zero
  // new events — a completely silent, successful run looked identical from the console to the scheduler
  // not running at all. Confirmed real: a manual run against real due instances updated their `updated_at`
  // and wrote fresh "success" rows to trigger_logs, with zero console output the whole time. This one line
  // is the fix — always prints, even (especially) when there was nothing else to say.
  console.log(`[scheduler] poll cycle: ${dueInstances.length} instance(s) due${dueInstances.length ? ` (${dueInstances.map((i) => `${i.app}.${i.trigger_key}`).join(", ")})` : ""}`);
  if (dueInstances.length === 0) return;

  let totalEvents = 0;

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

        const { events, nextCursor } = await trigger.poll(connection, instance.cursor, instance.config ?? null);
        totalEvents += events.length;

        for (const event of events) {
          await deliverEvent(instance, event);
        }

        await triggerInstanceStore.update(instance.trigger_instance_id, {
          cursor: nextCursor,
          status: "active",
          updated_at: new Date().toISOString(),
        });
        // Only log a standalone "poll ran" row when there's nothing else to say — when events were found,
        // each one already wrote its own evt_ row above (deliverEvent), and THAT is the record of this
        // cycle for this instance. Previously this fired unconditionally, so a cycle that found 3 events
        // wrote 4 rows for one unit of work (1 quiet tlog_ "success" + 3 evt_ deliveries) — inconsistent
        // with "log is one unit per thing that happened". A poll that finds nothing still needs its own
        // row (that's the only proof-of-life for a quiet cycle — see the console.log above this function).
        if (events.length === 0) {
          await logPollRun(instance, "success");
        }
      } catch (err) {
        // One trigger instance failing (e.g. a revoked token) must not take down the whole poll cycle —
        // mark just that instance as errored and move on; every other instance still gets its turn.
        console.error(`[scheduler] poll failed for trigger_instance ${instance.trigger_instance_id}:`, err);
        await logPollRun(instance, "error", formatError(err));
        await triggerInstanceStore.update(instance.trigger_instance_id, {
          status: "error",
          updated_at: new Date().toISOString(),
        });
      }
    }),
  );

  console.log(`[scheduler] poll cycle done: ${totalEvents} new event(s) found across ${dueInstances.length} instance(s)`);
}

// `globalThis`, not a plain module-level `let` — `bun --hot worker.ts` re-executes this module's top-level
// code (including worker.ts's own unconditional `startScheduler()` call) on every file change ANYWHERE in
// its import graph, not just this file. A plain module-level variable gets reset right along with that
// re-execution, so it can't detect "a previous interval is already running" across a reload — only
// `globalThis` genuinely persists across module re-evaluation within the same process. Without this,
// every hot-reload during dev silently stacks one more concurrent setInterval on top of all the previous
// ones (found in production-shaped testing: 24 poll attempts in 8 minutes against an 8-minute
// poll_interval_ms, instead of ~1) — each individually harmless-looking, but compounding fast under heavy
// editing. Production (`bun worker.ts`, no --hot) never hits this: startScheduler() runs exactly once.
const SCHEDULER_INTERVAL_KEY = Symbol.for("anox.scheduler.interval");

export function startScheduler(): ReturnType<typeof setInterval> {
  const g = globalThis as unknown as Record<symbol, ReturnType<typeof setInterval> | undefined>;
  if (g[SCHEDULER_INTERVAL_KEY]) {
    clearInterval(g[SCHEDULER_INTERVAL_KEY]);
  }
  const interval = setInterval(() => {
    runTriggerPollCycle().catch((err) => console.error("[scheduler] poll cycle threw:", err));
  }, SCHEDULER_TICK_MS);
  g[SCHEDULER_INTERVAL_KEY] = interval;
  return interval;
}

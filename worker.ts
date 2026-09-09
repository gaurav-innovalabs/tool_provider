// Separate process from index.ts (the API server) — "we have a separate background worker which can
// serve this polling triggers." Runs ONLY the trigger scheduler (src/core/scheduler.ts), no HTTP server
// at all. Keeps trigger polling off the same event loop that's handling API requests — a slow/stuck poll
// cycle can't make the API server unresponsive, and vice versa.
//
// Only POLL-mode triggers (Gmail new_email, new_labeled_email) run here. WEBHOOK-mode triggers (Slack
// new_message) are delivered by the API server itself (src/api/webhook_routes.ts's
// /webhooks/slack/events) — that's where Slack's inbound POSTs actually land, this worker has nothing to
// do with them.
//
// Run both processes for triggers to actually fire: `bun run start` (API server) and `bun run worker`
// (this file). Neither depends on the other being up — the API server works fine with the worker down
// (you just won't get trigger deliveries); the worker works fine with the API server down (existing
// TriggerInstances keep polling/receiving webhooks, you just can't create new ones via the API).
//
// Single worker process by design — only one `bun run worker` is ever run at a time, no locking needed.

import "./src/config"; // validate env first — same reason index.ts does this
import { startScheduler } from "./src/core/scheduler";

startScheduler();
console.log("trigger worker running — separate process from the API server, each trigger uses its own poll interval");

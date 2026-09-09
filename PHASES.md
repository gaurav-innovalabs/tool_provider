# Build phases

Progressive build. Each phase is scoped so it can be picked up independently — the shape stays stable
across phases, they fill it in. Status reflects what's actually real and verified (see MIGRATIONS.md,
tool_provider.http, and each chat exchange's live-endpoint tests), not just declared/stubbed.

## Phase 1 — Connection lifecycle ✅ DONE
- App registry: `gmail`, `slack` (oauth2), `serpapi` (api_key). `AppAuthConfig` supports oauth2/api_key/none/custom.
- `POST /connections` returns the SAME shape for every auth type — `{connection_id, status, connect_url?}`, never secrets, never a field schema in the JSON. `connect_url` is a random, single-use, Redis-backed token (`src/lib/redis.ts` — genuinely wired now, not just scaffolded) resolved server-side, not the raw connection_id.
- `GET/POST /connect/:token`: oauth2 → redirects straight to the provider's consent screen → `/oauth/callback/:app` → active. api_key → serves our own plain-HTML field-collection form; submitting it runs the App's real `testConnection()` (an actual provider API call) before activating — a bad value re-renders the same form with the real error, token stays valid to retry.
- `/admin/*` — ✅ now implemented for real (was blocked only on the store being real, which it now is).
- Verified end-to-end against real Google/Slack/SerpApi endpoints AND a real local Redis.

## Phase 2 — Actions ✅ DONE
- 11 real actions: Gmail (`send_email`, `list_recent_emails`, 5 label CRUD, `create_draft`), Slack (`post_message`, `list_channels`), SerpApi (`search`).
- Every action declares real zod `input`/`output` schemas — enforced at the dispatch boundary (`POST /actions/:app/:action`), also used to auto-generate `/openapi.json` (see `src/openapi.ts`).
- No SDKs — plain `fetch` against each provider's REST API, kept deliberately lean.

## Phase 3 — Triggers ✅ DONE (Gmail polling + Slack webhook, both real and verified)
- ✅ **Worker split**: trigger polling runs in a SEPARATE process (`worker.ts`, `bun run worker`) from the API server (`index.ts`) — a stuck/slow poll cycle can't make the API unresponsive and vice versa. Both need to be running for triggers to actually fire. Webhook-mode triggers (Slack) are delivered by the API server itself (that's where the inbound POST lands), not the worker — the worker only matters for poll-mode triggers (Gmail).
- ✅ Scheduler (`src/core/scheduler.ts`): **no global poll interval** — verified from Pipedream's actual published npm package (`@pipedream/platform`'s `DEFAULT_POLLING_SOURCE_TIMER_INTERVAL = 60 * 15`, a per-source default, not a global one) and Composio's per-trigger `trigger_config.interval`. Each `TriggerInstance` carries its own `poll_interval_ms`, resolved at subscribe time from the trigger's `defaultPollIntervalMs` (or an explicit override). `SCHEDULER_TICK_MS` = 2 min (checks what's due, not a per-trigger cadence); each Gmail trigger's own default is 8 min — a never-polled instance is picked up on the very next tick regardless, to seed its cursor promptly. Delivers to `webhook_url` with a Composio-style envelope (`{id, type, metadata, data, timestamp}`), verified against a real local HTTP receiver. One instance failing (bad token, etc.) is isolated — marked `error`, doesn't kill the cycle for other instances (verified with a real Gmail 401).
- ✅ `GET /triggers` — lists every real trigger from the registry (not hand-maintained), including each one's `default_poll_interval_ms`. `POST /triggers/:app/:trigger/subscribe` — real, takes `{connection_id, webhook_url, poll_interval_ms?}`, validates connection is active and belongs to that app, creates the `TriggerInstance`. `DELETE /triggers/:id` — unsubscribe.
- ✅ Gmail `new_email`: real `history.list` + `historyId` cursor implementation (per `research/gmail-deep-dive.md` — not timestamp polling), reseeds on a 404 (expired cursor). 8-min default interval.
- ✅ Gmail `new_labeled_email`: fires when a label is applied to a message — real trigger, verified directly against Pipedream's actual source (`components/gmail/sources/new-labeled-email/`). A fabricated "new_label" (label *creation*) trigger was built first and then removed — Gmail has no event feed for label creation at all (only message-level `labelAdded`/`labelRemoved`), confirmed by exhaustively listing all 5 of Pipedream's real Gmail sources (none of them is label-creation either).
- ✅ Gmail `create_draft` action added alongside the trigger work — verified against Pipedream's real (and only) draft-related Gmail action.
- ✅ Slack `new_message` — **real webhook trigger, built and verified end-to-end**: `POST /webhooks/slack/events` handles Slack's `url_verification` handshake, real HMAC-SHA256 signature verification (`src/lib/slackSignature.ts`, same algorithm n8n's real `SlackTrigger.node.ts` implements — replay-guarded via a 5-min timestamp window), looks up the right `Connection` by `team_id` (captured at OAuth-exchange time, `src/lib/oauth.ts`), filters out bot/own messages, and delivers to every matching active `TriggerInstance`'s `webhook_url` via the same `deliverEvent()` the poll-based scheduler uses. Verified with real computed signatures: valid/invalid/stale-timestamp cases, bot-message filtering, and a full connection→instance→delivery round trip against a real local HTTP receiver.
- Outbound delivery signing (HMAC) for `webhook_url` deliveries — explicitly **not needed for now**, per spec. Not built. (Slack's INBOUND signature verification above is still real and required — that's a different concern, us verifying Slack, not a receiver verifying us.)
- ✅ Retry/circuit-breaker: explicitly decided AGAINST — "no need to retry at all, just failed ok". A failed poll or delivery writes one `trigger_logs` row with `status: "error"` and is left alone; no retry queue, by design, not by omission.
- ✅ **`trigger_logs` table** (`src/db/schema.ts`, `triggerLogStore` in `core/store.ts`): one row per trigger RUN — every poll attempt (`src/core/scheduler.ts`'s `logPollRun`, even when it produces zero events) and every webhook delivery attempt (`deliverEvent`, poll-mode and Slack webhook-mode alike, since both call the same function). `trigger_instance_id` FK is `onDelete: cascade` so `DELETE /triggers/:id` can still delete an instance that has log history. Exposed read-only via `GET /admin/trigger_logs?limit=`. Verified live: seeded a real gmail trigger instance with a broken connection, ran a real poll cycle, confirmed the resulting error row in `psql`, then confirmed the cascade delete actually works (instance + its logs both gone, no FK violation).
- TODO: `GET /admin/trigger_logs` needs real pagination (cursor/offset), not just a flat `limit` — same gap as `/admin/logs` for action_logs. **[Low priority for now]**
- TODO: a "resend to webhook" action per `trigger_logs` row — re-POST that row's already-captured event payload to the instance's current `webhook_url` on demand (admin-triggered, not automatic — still no background retry queue, this is a manual one-off re-send). Needs the row to actually store the delivered `data` payload, which it doesn't yet (only status/error). **[Low priority for now]**
- Still open: does a `new_message` `TriggerInstance` need a specific `channel_id` at subscribe-time, or does it fire for every channel the app is in? Currently: every channel.

## Phase 4 — Durable storage — DONE
- ✅ Encryption at rest: AES-256-GCM (`src/lib/cipher.ts`), verified round-trip + tamper detection. Every `Connection.secrets` is encrypted before it touches `core/store.ts`.
- ✅ Migrations: Drizzle, forward-only by design, verified against real Postgres (`MIGRATIONS.md`), applied to the real `tool_provider` database (`bun run db:migrate`).
- ✅ **Linked**: `core/store.ts` is real Drizzle/Postgres (`src/lib/postgres.ts`'s `orm`, on `Bun.sql`) — in-memory Maps removed entirely. Verified live: created a user + connection through the real API, confirmed the rows in `psql` directly, killed the server process, restarted it, and re-fetched the same connection from the fresh process — data survived. `worker.ts` and `index.ts` both connect to the same database with no errors, and `bun run dev` boots both in parallel (Bun's native `--parallel`, no Turborepo).
- ✅ Token refresh: `src/lib/oauth.ts`'s `refreshToken()` is real — standard `grant_type=refresh_token`, works for both Gmail (always returns a fresh token, never a new `refresh_token`) and Slack (only relevant if the Slack app has token rotation enabled — its rotation flow returns a new single-use `refresh_token` each time, handled the same way). Wired in via `src/core/tokenRefresh.ts`'s `ensureFreshConnection()` — refresh-AHEAD-of-expiry (5 min margin, per `research/auth-patterns.md` #4's real Nango pattern), called before every action (`action_routes.ts`) and every poll (`scheduler.ts`); a no-op for api_key connections or any oauth2 token not close to expiry. A refresh failure marks the connection `error` and throws — no retry, same "just fail" decision as triggers. Verified live: a token with no `refresh_token` throws the expected reconnect-needed error; a fake `refresh_token` against Google's real token endpoint surfaces Google's real `invalid_grant` error.
- Redis (`src/lib/redis.ts`) is now genuinely in use (connect tokens, Phase 1) — the Phase 3 scheduler's per-instance locking (`acquireTriggerLock`) is still the unimplemented part. S3 (`src/lib/s3.ts`, use still unconfirmed) — client exists, unused.

## Phase 5 — Multi-tenant / bring-your-own OAuth app — NOT STARTED
- Let a caller override the shared `.env` OAuth app with their own client_id/secret (Auth Config concept, per `research/auth-patterns.md` #1 and #3).
- `auth_configs` table separated from `connected_accounts` (Composio-style split) — matches the real gap noted in `tool_provider.http`'s Composio comparison (no auth-config API exists here at all yet).

## Phase 6 — Outbound trigger delivery + more apps — NOT STARTED
- Decide fan-in single webhook per consumer vs per-trigger endpoint (`research/triggers-patterns.md` — currently leaning fan-in).
- HMAC signing for outbound deliveries — not needed for now, per spec (Phase 3). No retry/circuit-breaker either — explicitly decided against, `trigger_logs` is the audit trail instead.
- Add more Apps beyond Gmail/Slack/SerpApi once the shape is proven.

## Phase-MCP — Dynamic tool discovery + on-demand connect over MCP — NOT NOW, planned only
Explicitly deferred — this is a design target, not scheduled work. Full research: `research/mcp-connect-flow.md`.
- Confirmed pattern from Composio's Tool Router and Pipedream's MCP server (both real, both verified from
  their own docs — not guessed): a **small fixed set of meta-tools** (`search_tools`, `execute_tool`,
  `manage_connection`) instead of one MCP tool per action; **`user_id` bound once** at MCP-session/config
  time (env var or header), never passed per call; a tool call against an app the user isn't connected to
  returns a **normal tool result containing a connect URL**, not an error — the agent surfaces it
  conversationally, the user connects, the next call just works.
- Maps onto primitives we already have: `manage_connection` would wrap `POST /connections` (already returns
  `connect_url` for oauth2, immediate-active for api_key/none) instead of new auth logic; `execute_tool`
  wraps `POST /actions/:app/:action` (already real); `search_tools` starts as simple keyword match over
  `listApps()`/`getApp()` (`src/core/registry.ts`) — no need for real semantic search at ~10 actions.
- Also missing today, needed before this phase makes sense: `AuthKey` gating (still unenforced everywhere)
  and probably Phase 4's real storage (an MCP server process living longer than one request needs
  connections to survive a restart).

---
Work on later phases can start in parallel once Phase 1's types (`src/types.ts`) are stable, since every phase builds on that same App/Action/Trigger/Connection shape.

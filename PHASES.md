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

## Phase-MCP-1 — stdio MCP server, meta-tools — ✅ DONE
Full guide: `MCP_GUIDE.md`. Research: `research/mcp-connect-flow.md` (Composio/Pipedream pattern,
confirmed from their own docs) + `research/mcp-sdk-notes.md` (the real `@modelcontextprotocol/sdk`
mechanics, confirmed against the installed 1.30.0 package's own `.d.ts`).
- ✅ Three meta-tools, not one MCP tool per action, per the confirmed Composio/Pipedream shape:
  `search_tools` (keyword match over `listApps()`, `src/core/registry.ts` — fine at ~10 actions, per spec),
  `manage_connection` (get-or-create a connection, same three states `POST /connections` already returns),
  `execute_tool` (same dispatch as `POST /actions/:app/:action`, reusing `ensureFreshConnection` +
  `actionLogStore`). Schemas: `src/mcp/types.ts`. Implementations: `src/mcp/metaTools.ts` — real, calls the
  same store/registry/lib functions the REST routes call (not the routes themselves; see `MCP_GUIDE.md`'s
  "why a separate layer" section for why this isn't built as new REST routes).
- ✅ Not-connected `execute_tool` call returns `{status:"not_connected", connect_url}` as a normal tool
  result instead of an error — the confirmed pattern, not a guess.
- ✅ `user_id` bound once per process (`MCP_USER_ID` env var, stdio transport) — never passed per call.
- ✅ `AuthKey` gating — real for this entrypoint (`MCP_AUTH_KEY` checked against `config.security.AuthKey`
  at startup, fail-closed, verified live: wrong key throws immediately, right key stays running). The
  REST API's own long-standing `AuthKey` TODO (`src/server.ts`) is separate and still not done — this
  phase didn't touch it, on purpose (see `MCP_GUIDE.md`'s auth model section).
- ✅ `@modelcontextprotocol/sdk` added (`bun add`, resolved to 1.30.0), `bun run mcp` (`mcp.ts`) entrypoint,
  full `bun run typecheck` pass.
- **Not yet done**: a real MCP client (Claude Desktop/Code) actually driving all three tools end-to-end —
  only the process-boot smoke test (fail-closed + happy-path-stays-running) has been verified so far. Do
  this next.
- **Explicitly deferred, not guessed at**: MCP-protocol-level error vs. `isError:true` for a failed
  `execute_tool` (needs a real client to decide), dynamic tool *registration* (SDK supports it, not needed
  while the meta-tool set is fixed).

## Phase-MCP-2 — remote/multi-tenant HTTP transport + browser login — ✅ DONE
The Bun/SDK blocker cleared: `@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport`
(`server/webStandardStreamableHttp.js`) is Fetch-API-shaped (`handleRequest(req: Request): Promise<Response>`)
and plugs directly into `Bun.serve()` routes — confirmed against the installed 1.30.0 package's own
`.d.ts`, no Express/Node-http adapter needed.
- ✅ `GET/POST/DELETE /mcp` (`src/mcp/httpServer.ts`) — one `McpServer` + transport per authenticated HTTP
  session (`sessions` map keyed by the transport's own session id), bearer token resolved on the
  session-initializing request only (`authorization: Bearer <token>` header, or `?token=` query param for
  clients that only accept a URL, per Pipedream's documented fallback). Missing/invalid token -> 401, not a
  crash — verified live with a client carrying no token at all.
- ✅ **Browser "MCP login"** (`GET/POST /mcp/login`, `src/lib/connectPage.ts`'s `mcpLoginFormPage`/
  `mcpLoginSuccessPage`) — types the access key into a real page instead of hand-editing an MCP client's
  JSON config: submits `access_key` (checked against the same `config.security.AuthKey` stdio mode already
  uses), creates a fresh `User`, mints a long-lived token (`src/lib/mcpTokens.ts`, Redis-backed, no TTL —
  a credential, not a one-time link, unlike `lib/redis.ts`'s connect tokens), and shows the ready-to-paste
  MCP URL + token once. Wrong key re-renders the form with a real error — verified live.
- ✅ `buildMcpServer(userId)` (`src/mcp/server.ts`) factored out as a pure, transport-agnostic builder —
  shared by stdio's `createMcpServer()` (env-var userId, checked once at process start) and the HTTP
  session manager (per-session userId, checked once per session-initializing request). Same three
  meta-tools, same behavior, on both transports.
- ✅ **Verified fully live, real HTTP, real SDK client** (not just curl): booted the real API server against
  real Postgres/Redis, created a real user, logged in through the actual `/mcp/login` form (wrong key
  rejected, right key issued a token), then drove the remote `/mcp` endpoint with the SDK's own
  `StreamableHTTPClientTransport` — `tools/list`, `search_tools`, and `manage_connection` all returned real
  results, including a `connect_url` for Slack that resolves to a genuine `slack.com/oauth/v2/authorize`
  redirect (real client_id, scopes, state). A request with no bearer token was rejected with 401, not a
  crash.
- TODO: token revocation (`redis.del` exists as the primitive, no route calls it yet); "log back in as an
  existing user_id" (every `/mcp/login` currently mints a brand-new `User` — fine for a first pass, a
  returning-user path would need its own credential); MCP-protocol-level auth-server metadata
  (`/.well-known/oauth-protected-resource`) if a client ever requires full OAuth discovery instead of a
  pasted bearer token — not attempted, this is a simpler "paste a key" flow by design, not OAuth 2.1.

## Phase-MCP-3 — outputSchema, wait_for_connection, get_tool_schema, triggers-via-MCP, app scoping — ✅ DONE
Full detail: `MCP_GUIDE.md`. 7 meta-tools total now (was 3): `search_tools`, `get_tool_schema`,
`manage_connection`, `wait_for_connection`, `execute_tool`, `list_triggers`, `subscribe_trigger`.
- ✅ **`outputSchema` on every tool**, not just `inputSchema` — clients get validated `structuredContent`,
  not a text blob to `JSON.parse()`. Hit and fixed a real SDK gotcha along the way: `outputSchema` (and
  `structuredContent`) is **silently dropped** for a `z.union`/`z.discriminatedUnion` output (converts to
  `oneOf`, not a plain object, and the SDK just doesn't register it — no error) — confirmed live via
  `tools/list` before/after. Fixed by flattening every multi-state output (`manage_connection`,
  `execute_tool`, `wait_for_connection`, `subscribe_trigger`) to one object with optional fields instead of
  a union of variants. Documented in `MCP_GUIDE.md` as a gotcha for the next person adding a meta-tool.
- ✅ `wait_for_connection` — blocks (real polling of `connectionStore`, 3s interval, configurable timeout up
  to 10 min) until a pending connection goes active/errors/times out, closing the gap where an agent had no
  way to know a connect finished other than blindly retrying `execute_tool`. Verified live: genuinely
  polled for the full timeout window against a real pending connection, returned `status:"timeout"`.
- ✅ `get_tool_schema` — real per-action JSON Schema via zod v4's native `z.toJSONSchema()` (same converter
  `src/openapi.ts` already uses for `/openapi.json` — no new dependency, no bespoke conversion). Verified
  live against Gmail's `send_email` action, matched its real zod schema exactly.
- ✅ `list_triggers` / `subscribe_trigger` — triggers (Gmail polling, Slack webhooks — real since Phase 3)
  now reachable via MCP, not just the REST API. `subscribe_trigger` resolves the connection from
  `user_id`+`app` (reusing the same get-or-create helper `execute_tool` uses) instead of requiring a
  `connection_id` up front, matching this layer's user_id-first model. Verified live: `list_triggers`
  returned real Gmail/Slack trigger data, `subscribe_trigger` on an unconnected app returned the same
  `not_connected`+`connect_url` shape `execute_tool` does.
- ✅ **App scoping** — a session can be restricted to a subset of apps (`MCP_APPS` env var for stdio, an
  optional "Limit to apps" field on `/mcp/login` for remote, carried in the token payload —
  `src/lib/mcpTokens.ts`'s `McpTokenPayload.apps`). Enforced in `src/mcp/metaTools.ts`'s
  `assertAppAllowed()` on every tool. Verified live on both transports: a call against an out-of-scope app
  returned a clean tool error (`App "gmail" is outside this session's scope (allowed: slack)`), not a crash.
- ✅ Deliberately NOT built, by explicit request: parallel multi-tool execution, MCP resources/prompts.
- ✅ Deliberately NOT built, with reasoning (see `MCP_GUIDE.md`'s closing section for the full case): full
  MCP OAuth 2.1 discovery (`/.well-known/oauth-protected-resource`, PKCE, dynamic client registration) —
  a different-sized feature (a real authorization server), not a small addition, and the current
  paste-a-key-get-a-token flow already works with any client accepting a bearer token; "durable sessions
  surviving a restart" — the credential (bearer token) already survives a restart via Redis, and the
  in-memory live protocol/SSE session state is inherent to any HTTP-streaming MCP server (including
  Composio's own hosted one), not a gap to engineer around.
- ✅ Full `bun run typecheck` pass; verified live end-to-end on both stdio and remote HTTP transports with
  the SDK's own client (not curl-only) after every change in this phase, including a re-verification after
  discovering the server process needed a restart to pick up the outputSchema fix (no hot-reload on `bun
  index.ts`, only `bun --hot`/`bun run dev`).

---
Work on later phases can start in parallel once Phase 1's types (`src/types.ts`) are stable, since every phase builds on that same App/Action/Trigger/Connection shape.

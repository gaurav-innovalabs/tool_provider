# Build phases

Progressive build. Each phase is scoped so it can be picked up independently — the shape stays stable
across phases, they fill it in. Status reflects what's actually real and verified (see MIGRATIONS.md,
tool_provider.http, and each chat exchange's live-endpoint tests), not just declared/stubbed.

## Phase 1 — Connection lifecycle ✅ DONE
- App registry: `gmail`, `slack` (oauth2), `serpapi` (api_key). `AppAuthConfig` supports oauth2/api_key/none/custom.
- `POST /connections` returns the SAME shape for every auth type — `{connection_id, status, connect_url?}`, never secrets, never a field schema in the JSON. `connect_url` is a random, single-use, Redis-backed token (`src/lib/redis.ts` — genuinely wired now, not just scaffolded) resolved server-side, not the raw connection_id.
- `GET/POST /connect/:token`: oauth2 → redirects straight to the provider's consent screen → `/oauth/callback/:app` → active. api_key → serves our own plain-HTML field-collection form; submitting it runs the App's real `testConnection()` (an actual provider API call) before activating — a bad value re-renders the same form with the real error, token stays valid to retry.
- `/admin/*` routes exist, still stubbed (Phase 4's real store makes finishing these cheap).
- Verified end-to-end against real Google/Slack/SerpApi endpoints AND a real local Redis.

## Phase 2 — Actions ✅ DONE
- 10 real actions: Gmail (`send_email`, `list_recent_emails`, 5 label CRUD), Slack (`post_message`, `list_channels`), SerpApi (`search`).
- Every action declares real zod `input`/`output` schemas — enforced at the dispatch boundary (`POST /actions/:app/:action`), also used to auto-generate `/openapi.json` (see `src/openapi.ts`).
- No SDKs — plain `fetch` against each provider's REST API, kept deliberately lean.

## Phase 3 — Triggers (polling engine first) — NOT STARTED
- Gmail `new_email`: polling via `history.list` + `historyId` cursor (per `research/gmail-deep-dive.md` — not timestamp polling).
- Slack `new_message`: still open — TODO(ask) in `src/components/slack/triggers/newMessage.ts` (poll vs. Slack's native Events API webhook).
- `POST /triggers/:app/:trigger/subscribe` exists, throws "not implemented". Trigger instance lifecycle + scheduler loop not built.

## Phase 4 — Durable storage — PARTIALLY DONE
- ✅ Encryption at rest: AES-256-GCM (`src/lib/cipher.ts`), verified round-trip + tamper detection. Every `Connection.secrets` is encrypted before it touches `core/store.ts`.
- ✅ Migrations: Drizzle, forward-only by design, verified against real Postgres (`MIGRATIONS.md`).
- ❌ **Not linked yet**: `core/store.ts` is still in-memory (dies on restart) — the migrations exist but the app doesn't use Postgres at runtime. This is the single biggest remaining gap.
- ❌ Token refresh: `src/lib/oauth.ts`'s `refreshToken()` still throws "not implemented" — tokens will silently expire.
- Redis (`src/lib/redis.ts`) is now genuinely in use (connect tokens, Phase 1) — the Phase 3 scheduler's per-instance locking (`acquireTriggerLock`) is still the unimplemented part. S3 (`src/lib/s3.ts`, use still unconfirmed) — client exists, unused.

## Phase 5 — Multi-tenant / bring-your-own OAuth app — NOT STARTED
- Let a caller override the shared `.env` OAuth app with their own client_id/secret (Auth Config concept, per `research/auth-patterns.md` #1 and #3).
- `auth_configs` table separated from `connected_accounts` (Composio-style split) — matches the real gap noted in `tool_provider.http`'s Composio comparison (no auth-config API exists here at all yet).

## Phase 6 — Outbound trigger delivery + more apps — NOT STARTED
- Decide fan-in single webhook per consumer vs per-trigger endpoint (`research/triggers-patterns.md` — currently leaning fan-in).
- Add signing (HMAC) + circuit breaker for dead receiver endpoints.
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

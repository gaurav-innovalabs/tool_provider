# Nango

- **Repo**: [NangoHQ/nango](https://github.com/NangoHQ/nango) — ~11.8k stars, actively developed. Tagline: "Build product integrations with AI" (pivoted messaging toward AI/agent use cases, but the core is a **unified auth + data-sync integration platform**).
- **License**: `Other` per GitHub API — check `LICENSE` file directly before reuse; historically Elastic License 2.0 for some components with an OSS core (Nango has changed licensing over time, verify current terms before depending on it).
- **Stack**: TypeScript monorepo. Key packages: `packages/shared` (core services), `packages/server` (API), `packages/webhooks` (outbound webhook dispatch to Nango's own customers), `packages/jobs` (background workers, sync execution), `packages/providers` (per-3rd-party-API auth/config definitions), `packages/runner-sdk` / `packages/node-client` (SDKs).

## Architecture overview
Nango is the most directly relevant reference for the "Auth flow first" priority: **its entire product is a dedicated unified-auth + connection-management layer**, decoupled from any specific automation/workflow engine. A "Connection" (`packages/shared/lib/services/connection.service.ts`) is the core entity: one connection = one end-user's credentials for one third-party provider, tracked with expiry, refresh state, and failure counters. "Syncs" (`packages/shared/lib/services/sync/sync.service.ts`) are Nango's trigger/data-fetch layer built on top of connections.

## Auth model (primary focus — most detailed section)
- **Multi-auth-type, not just OAuth2**: `connection.service.ts` imports separate client modules per auth scheme — `assertion.js` (SAML/JWT assertion-based), `aws-sigv4.js` (AWS signature auth), `bill.js` (Bill.com-specific), `githubApp.js` (GitHub App installation tokens), `jwt.js` (generic JWT-based auth), `signature.js` (generic HMAC-style signed-request auth), plus `oauth2.client.js` and `mcpGeneric.client.ts`. This confirms a **pluggable-per-auth-type client** architecture rather than assuming OAuth2 is universal — important since many real APIs use API keys, JWT, or custom signing, not just OAuth2.
- **Provider registry**: `packages/providers` holds declarative per-API definitions (`getProvider()` from `@nangohq/providers`) — i.e. "how does Slack's OAuth work, what are its token/refresh URLs, what auth mode does it use" is data, not code, similar in spirit to n8n's declarative credential schema but centered purely on auth (Nango has 400+ pre-defined providers).
- **Proactive refresh with margin + backoff tracking**: `connection.service.ts` computes `credentials_expires_at` from parsed credentials (`getExpiresAtFromCredentials`) and refreshes ahead of expiry using a `REFRESH_MARGIN_MS` constant (defined/used in `packages/shared/lib/services/connections/utils.ts` and `connections/credentials/refresh.ts`) rather than waiting for a 401 — i.e. refresh is scheduled proactively, not purely reactive-on-failure.
- **Refresh failure handling is a first-class state machine**: connection rows track `last_refresh_success`, `last_refresh_failure`, `refresh_attempts`, and `refresh_exhausted`, with a `MAX_CONSECUTIVE_DAYS_FAILED_REFRESH` cutoff — after repeated failures a connection is marked exhausted rather than retried forever. This is a concrete, reusable pattern: don't retry broken credentials indefinitely, surface a "reconnect needed" state instead.
- **Encryption at rest**: every write path calls `getEncryptionManager().encryptConnection(...)` before persisting (`packages/shared/lib/utils/encryption.manager.ts`) — credentials are never stored plaintext, decrypted only on read for actual use against the third-party API.
- **MCP-specific auth**: `mcpGeneric.client.ts` + `refreshMcpGenericCredentials` and `packages/server/lib/controllers/mcp/connections/get.ts`, `packages/server/lib/controllers/mcp/management.integration.test.ts` show Nango already has an MCP-facing connection-management surface — directly relevant prior art for exposing "connect your account" flows to an MCP client/agent.

## Trigger model
Nango's trigger surface is smaller/less central than n8n's — two mechanisms:
- **Syncs** (`packages/shared/lib/services/sync/sync.service.ts`, executed via `packages/jobs`): scheduled/polling data-fetch jobs per connection, more ELT-style ("keep a mirrored dataset fresh") than event-trigger-style.
- **Outbound webhooks to Nango's customers** (`packages/webhooks/lib/`): `sync.ts`, `auth.ts`, `forward.ts`, `circuitBreaker.ts` — Nango notifies *its own users* (not third-party APIs) when a connection's auth completes, a sync runs, etc. `packages/server/lib/webhook/signature.ts` handles signing these outbound webhooks (HMAC signature so receivers can verify authenticity) — directly reusable pattern for the eventual build's own outbound webhook design. `circuitBreaker.ts` in the webhook dispatcher is worth reading for how they avoid hammering a dead receiver endpoint.
- No native "inbound third-party webhook trigger" system was found comparable to n8n's Webhook node — Nango is not itself a workflow/automation engine, so this is expected; it's a gap relative to Pipedream/n8n, not a design to copy.

## Tool/schema definition format
Not tool-schema-oriented in the MCP sense historically — Nango's unit of definition is a **provider config** (auth + endpoint metadata) plus optional **sync/action scripts** (`packages/runner-sdk`) written by the integrator. The recent `mcp/` controllers suggest they're layering MCP tool exposure on top of this rather than it being native from the start — worth checking their MCP docs directly for the current schema shape before assuming stability.

## Notable code pointers
| Purpose | Path |
|---|---|
| Core connection lifecycle (create/refresh/store) | `packages/shared/lib/services/connection.service.ts` |
| Per-auth-type clients | `packages/shared/lib/clients/{oauth2,mcpGeneric,provider}.client.ts`, `packages/shared/lib/auth/{assertion,aws-sigv4,githubApp,jwt,signature,bill}.ts` |
| Refresh scheduling + failure state | `packages/shared/lib/services/connections/credentials/refresh.ts`, `connections/utils.ts` |
| Encryption | `packages/shared/lib/utils/encryption.manager.ts` |
| Declarative provider registry | `packages/providers/` |
| Sync (poll-based data fetch) | `packages/shared/lib/services/sync/sync.service.ts` |
| Outbound webhook dispatch + signing | `packages/webhooks/lib/*.ts`, `packages/server/lib/webhook/signature.ts`, `dispatch.ts` |
| MCP connection management | `packages/server/lib/controllers/mcp/connections/get.ts`, `packages/server/lib/controllers/mcp/management.integration.test.ts` |

## Takeaways
- **Borrow (high priority for auth-first design)**: pluggable per-auth-type client architecture (don't hardcode OAuth2 as the only scheme); declarative provider registry as data; proactive refresh-ahead-of-expiry with a margin constant; explicit refresh-failure state machine with an "exhausted, needs reconnect" terminal state instead of infinite retry; HMAC-signed outbound webhooks with a circuit breaker for dead receivers.
- **Avoid/watch**: license terms need verifying before any code reuse (not a clean permissive OSS license historically); Nango's trigger/automation story is thin — don't look to it for trigger-engine design, only for auth. Its MCP surface looks recently added/evolving — treat as directional inspiration, not a stable spec to copy verbatim.

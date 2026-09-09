# MCP Guide — Phase-MCP-1 (stdio, local) + Phase-MCP-2 (remote HTTP + browser login), both real

How to expose this tool provider as an actual MCP server, Composio-Tool-Router-style: a small fixed set of
meta-tools instead of one MCP tool per action, `user_id` bound once, "not connected" comes back as a normal
tool result with a connect link instead of an error. Design research: `research/mcp-connect-flow.md`
(Composio + Pipedream, confirmed from their own docs) and `research/mcp-sdk-notes.md` (the actual TS SDK).
Phase tracking: `PHASES.md`'s Phase-MCP section — this file is the "how", that file is the "what's real".

## Why a separate `src/mcp/` layer, not new REST routes

The REST API (`src/api/*_routes.ts`) and this MCP server are two front doors onto the same core
(`src/core/store.ts`, `src/core/registry.ts`, `src/lib/*`) — neither wraps the other. `src/mcp/metaTools.ts`
calls the same store/registry/lib functions the REST routes call, not the routes themselves (a route
handler's signature is `Request -> Response`, not a callable function). If a third caller ever needs this
same "get-or-create connection" / "run an action for a user" logic, factor it into a shared `core/*.ts`
helper then — not worth it for two call sites yet.

## The seven meta-tools

| Tool | Wraps | Not-connected behavior |
|---|---|---|
| `search_tools` | `listApps()` (`src/core/registry.ts`), keyword match | n/a |
| `get_tool_schema` | `z.toJSONSchema()` on one action's real input/output zod schemas | n/a |
| `manage_connection` | Same three states `POST /connections` already returns | n/a — this tool's whole job IS surfacing `connect_url` |
| `wait_for_connection` | Polls `connectionStore.get()` every 3s until active/timeout/failed | n/a |
| `execute_tool` | Same dispatch as `POST /actions/:app/:action` | Returns `{status:"not_connected", connect_url}` instead of a 409 |
| `list_triggers` | `listApps()`'s trigger definitions, same data `GET /triggers` returns | n/a |
| `subscribe_trigger` | Same as `POST /triggers/:app/:trigger/subscribe`, but resolves the connection from `user_id`+`app` instead of requiring a `connection_id` up front | Returns `{status:"not_connected", connect_url}` instead of a 409 |

`search_tools`/`get_tool_schema`/`manage_connection`/`execute_tool`/`list_triggers`/`subscribe_trigger` are
the confirmed Composio/Pipedream pattern (`research/mcp-connect-flow.md`); `wait_for_connection` fills the
one real gap in that pattern — without it, an agent has no way to know a connection actually completed
other than blindly retrying.

Schemas: `src/mcp/types.ts`. Implementations: `src/mcp/metaTools.ts` (real, not stubbed — reuses
`ensureFreshConnection`, `actionLogStore`, encryption-at-rest, everything Phase 1-4 already built).

### `outputSchema` — every tool declares one, and it matters

Every tool registers a real `outputSchema` (not just `inputSchema`), so a client gets validated
`structuredContent` back, not a JSON blob buried in a text content block to `JSON.parse()` itself.

**One real gotcha, worth knowing if you touch `src/mcp/types.ts`**: the SDK **silently drops**
`outputSchema` (and the resulting `structuredContent`) for any schema whose top-level JSON Schema isn't a
plain object — a `z.union`/`z.discriminatedUnion` converts to `oneOf` and gets rejected without an error,
it just quietly doesn't register. Caught live: `tools/list` showed `outputSchema` missing and the client
got `structuredContent: undefined` for every tool whose output used to be a union of "connected" vs.
"not_connected" shapes. Fixed by flattening every multi-state output (`manage_connection`, `execute_tool`,
`wait_for_connection`, `subscribe_trigger`) into **one object per tool with optional fields** instead of a
union of variant objects — same information, MCP-compatible shape. If you add a new meta-tool with more
than one possible result shape, follow that pattern, not a union.

### App scoping

A session can be restricted to a subset of apps instead of seeing the whole registry:

- stdio: `MCP_APPS` env var, comma-separated app ids (e.g. `MCP_APPS=gmail,slack`).
- Remote: the optional "Limit to apps" field on the `/mcp/login` form (same comma-separated format),
  carried inside the minted token's payload (`src/lib/mcpTokens.ts`'s `McpTokenPayload.apps`).

Unset/blank on either path = every app in the registry, same as before scoping existed. A call against an
out-of-scope app returns a clean tool error (verified live: `App "gmail" is outside this session's scope
(allowed: slack)`), not a crash.

## Running it

```sh
bun install                 # already done — @modelcontextprotocol/sdk added
bun run mcp                 # bun run mcp.ts — starts the stdio MCP server directly (for manual testing)
```

### Option A — stdio (local client config)

Requires two env vars, one optional third (**not** in `.env`):

- `MCP_USER_ID` — which `User` (`usr_...`, from `POST /users`) this session acts as. Bound once for the
  whole process — never passed per tool call.
- `MCP_AUTH_KEY` — must match `config.security.AuthKey` (the `.env` `AuthKey` var). Checked once at
  startup, fail-closed.
- `MCP_APPS` (optional) — comma-separated app scope, see above.

```json
{
  "mcpServers": {
    "tool-provider": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/tool_provider_project/mcp.ts"],
      "env": {
        "MCP_USER_ID": "usr_...",
        "MCP_AUTH_KEY": "<same value as .env's AuthKey>"
      }
    }
  }
}
```

### Option B — remote HTTP + browser login (recommended)

Instead of hand-editing JSON with raw env vars, point any remote-MCP-capable client at one URL and log in
through a real page:

1. Start the API server: `bun run dev` (or `bun index.ts`) — the login page and `/mcp` endpoint are served
   from the same `Bun.serve()` as the REST API (`src/server.ts`).
2. Open `{BASE_URL}/mcp/login` in a browser.
3. Type in the access key (same value as `.env`'s `AuthKey`), optionally a comma-separated app scope. A
   wrong key re-renders the form with an error.
4. On success you get a one-time screen with the **MCP server URL** (`{BASE_URL}/mcp`) and a **bearer
   token**. Copy both now — the token is never shown again.
5. In your MCP client's remote-server config, use the URL with either an `Authorization: Bearer <token>`
   header, or `{BASE_URL}/mcp?token=<token>` for a client that only accepts a plain URL (Pipedream's own
   documented fallback).

Each login mints a **brand-new `User`** — there's no "log back in as an existing user_id" path yet (see
TODO below).

## Auth model — two separate concerns, don't conflate them

1. **"Is this caller allowed to talk to this server at all?"** — `MCP_AUTH_KEY` (stdio) or the `/mcp/login`
   form's access key (remote), both checked against `config.security.AuthKey`. The REST API's own `AuthKey`
   gating (`src/server.ts`) is a separate, still-open TODO — not touched by this work.
2. **"Which end user is this?"** — `MCP_USER_ID` (stdio) or the bearer token minted at login (remote),
   resolved to `Connection` rows via the existing `user_id` → `connection_id` model.

## Verified live — both transports, real SDK client, not curl-only

- **stdio**: `Client` + `StdioClientTransport` against a real `usr_...` and real apps (`gmail`, `slack`,
  `serpapi`). All 7 tools called for real: `search_tools` hit the live registry, `get_tool_schema` returned
  real `z.toJSONSchema()` output matching the action's actual zod schema, `manage_connection`/`execute_tool`
  on an unconnected app returned `connect_url`s that resolve to genuine Google/Slack OAuth consent
  redirects (correct `client_id`, `redirect_uri`, scopes, `state`), `wait_for_connection` genuinely polled
  for the full timeout window and returned `status:"timeout"`, `subscribe_trigger` on an unconnected app
  returned the same `not_connected` shape, and `execute_tool` against an app outside `MCP_APPS`'s scope
  returned a clean tool error. An unknown app came back as `isError:true`, not a crash. The `serpapi`
  `api_key` connect form correctly rejected a bogus key via a real call to SerpApi's own API.
- **remote HTTP**: `Client` + `StreamableHTTPClientTransport` through the actual `/mcp/login` form (wrong
  key rejected, right key + an app-scope field issued a token), then all 7 tools over the real `/mcp`
  endpoint with `outputSchema`/`structuredContent` confirmed present on every one, and the same app-scope
  rejection confirmed on this transport too. A request with no bearer token got a 401, not a crash.

**Not yet verified** (can't be scripted from here): a bogus key **succeeding** end-to-end (needs a real
paid provider credential), a human clicking through Google/Slack's actual consent screen, and a GUI MCP
client (Claude Desktop/Claude Code's own UI, not the SDK driving it directly) — protocol-level behavior is
proven, that specific client's UX isn't.

## What's real vs. deliberately not built

**Real**: all 7 meta-tools with real `outputSchema`/`structuredContent`, both transports, app scoping,
startup/login auth-key gating, get-or-create-connection sharing the REST API's own connect-token flow,
not-connected returning a connect_url instead of an error, full `bun run typecheck` pass.

**Explicitly deferred, not guessed at — and why**:

- **Full MCP OAuth 2.1 discovery** (`/.well-known/oauth-protected-resource`, PKCE, dynamic client
  registration). This is a genuinely different-sized feature — a real authorization server, not a small
  addition — and would only matter for a specific MCP client that refuses a pasted bearer token and
  insists on spec discovery. The current "type a key into a page, get a token, paste it" flow is simpler
  and works with any client that accepts a bearer token or `?token=` query param (which is most of them
  today, per Pipedream's own documented fallback). Not started; would be its own phase if a real client
  ever requires it.
- **"Durable sessions surviving a restart"** — deliberately not built further than it already is, because
  there isn't more to build here without reimplementing what the SDK already does correctly: the
  **credential** (the bearer token, `src/lib/mcpTokens.ts`) is already Redis-backed and survives a restart
  fine. What's in-memory is the **live protocol session** (`src/mcp/httpServer.ts`'s `sessions` Map,
  SSE stream state) — and that's inherent to any HTTP-streaming MCP session, including Composio's own
  hosted one; a restart there drops live streams too. A client reconnecting after a restart just
  re-initializes (normal MCP behavior), it doesn't need to re-visit `/mcp/login` since the token itself
  survived. Nothing to fix.
- MCP-protocol-level error vs. `isError:true` content for a failed tool call — needs a real client's
  behavior to decide between, see the TODO comment in `src/mcp/server.ts`.
- Token revocation — `redis.del` exists as the primitive in `lib/mcpTokens.ts`'s shape but no route calls
  it yet.
- A "log back in as an existing user_id" path — every `/mcp/login` currently mints a brand-new user.
- Parallel multi-tool execution and MCP resources/prompts — explicitly out of scope per spec, not needed.

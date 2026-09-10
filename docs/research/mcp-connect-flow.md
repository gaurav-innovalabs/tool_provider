# MCP dynamic-tool-discovery + on-demand-connect pattern

R&D for a future phase (Phase-MCP, see `../../PHASES.md`) — **not implemented yet**. Goal: understand how
Composio and Pipedream expose their tool-provider as an actual MCP server (not just a REST API), so a
single MCP session can search for a tool, discover the user isn't connected to the app it needs, get a
connect link back as a normal tool result, and — once the user finishes connecting — have the very next
call to that same tool just work. `user_id` is fixed once at MCP-session/config time, not passed per call.

## Composio — confirmed, exact match

- MCP endpoint: `https://connect.composio.dev/mcp` ("Tool Router" / "Composio Connect").
- Exposes a **small, fixed set of meta-tools**, not one tool per app action. Confirmed by name:
  `search_tool` (agent describes a task, gets back relevant tools), `execute_tool` (runs one or more
  discovered tools, up to 50 in parallel), `manage_connections` (create/list/rename/remove a user's
  connections). A few more meta-tools exist (schema-lookup, code-execution) but weren't individually
  confirmed by name in this pass.
- `user_id` is bound **at session-creation time**, not per call: `composio.toolRouter.create(userId,
  config)` (SDK) / `POST /tool_router/session { user_id, toolkits }` (REST — matches the endpoint already
  in `tool_provider.http`'s Composio comparison section).
  [docs.composio.dev/reference/api-reference/tool-router/postToolRouterSession]
- **Not-connected case is a designed, documented behavior**: `manage_connections` "allows agents to handle
  in-chat authentication when a toolkit has no active connection, guiding users through connecting required
  accounts before executing." A session can also call `session.authorize()` to generate a Connect Link, with
  `waitForConnection()` resolving once the user finishes.
  [docs.composio.dev/tool-router/manually-authenticating-users, docs.composio.dev/docs/composio-connect]

## Pipedream — confirmed, same shape, different transport for user binding

- `user_id` (their `external_user_id`) travels as an **HTTP header** (`x-pd-external-user-id`) or query
  param on every request to their remote MCP server — not a created session object like Composio. In an
  MCP client's config for a remote server this is normally set once as a static header, so from the calling
  agent's perspective it still behaves like "fixed once in config," just implemented as a per-request header
  rather than a spawned-process env var. [pipedream.com/docs/connect/mcp/developers]
- **Not-connected case, confirmed as intended behavior directly from their docs**: "If a user doesn't have
  a connected account required for a given tool call, the server will return a URL in the tool call
  response" — format `https://pipedream.com/_static/connect.html?token=ctok_...&connectLink=true&app={appSlug}`.
  (There's an open community bug report of this 404ing in some cases — a regression, not a design change;
  it still confirms the intended behavior is the inline-connect-link pattern.)
  [pipedream.com/community/t/why-does-remote-mcp-server-return-404-instead-of-inline-connect-link]
- Whether tool exposure is per-action (like our current model) or dynamic search wasn't confirmed either
  way — worth a follow-up read if this becomes load-bearing.

## Gumloop — not relevant

Has an MCP server (`mcp.gumloop.com/gumloop/mcp`) and a separate OSS project (`guMCP`), but both control
*Gumloop's own workflows*, not a multi-app tool-connect broker. No dynamic-search or inline-connect-link
mechanism — not a useful reference for this pattern.

## Synthesis — the common shape

Both real examples converge on the same three-part design:

1. **A small, fixed set of meta-tools**, not one MCP tool per action — a search/discovery tool is the
   entry point, not a giant static tool list.
2. **`user_id` fixed once per MCP session/connection-config**, never passed per tool call.
3. **A not-connected tool call returns a normal tool result containing a connect URL**, not an error — the
   agent can surface it conversationally ("you need to connect Gmail first: <link>") and the user just
   retries the same request once they're done, no special-casing needed on the agent side.

The only structural difference between the two real implementations is *where* `user_id` lives — a created
session object (Composio) vs. a request header (Pipedream) — both amount to "supplied once when the MCP
connection is configured," matching exactly what was asked for: define `user_id` once in the MCP client
config (e.g. Claude Desktop's `mcp.json`), not per call.

## What this means for our eventual Phase-MCP design

Not decided yet (that's the phase itself) — but the shape to design against, informed by what's above:

- **Meta-tools, not per-action tools**: instead of exposing all 10 current actions (`gmail.send_email`,
  `slack.post_message`, ...) as 10 separate MCP tools, expose a handful — `search_tools` (find matching
  Action(s) across the registry by description), `execute_tool` (run one, by app+key, same shape as
  `POST /actions/:app/:action` already does), `manage_connection` (get-or-create a connection for an app,
  return a connect_url if not yet active).
- **`user_id` binding**: our MCP server process would take `user_id` once (env var at process start, or a
  header if hosted remotely like Pipedream's model) — matches this project's `user_id` → `connection_id`
  model already (`../../ARCHITECTURE.md`), just resolved once per MCP session instead of passed in every request.
- **The not-connected flow already exists as a building block**: `POST /connections` (api_key/none: active
  immediately; oauth2: `connect_url` pointing at our own `/connections/:id/authorize`) is exactly the
  primitive `manage_connection` would call — the MCP layer would just need to check for an existing active
  connection first, and if none exists, call the same `POST /connections` logic and hand back its
  `connect_url` as the tool result instead of erroring.
- **Search**: with only ~10 actions today, a real semantic search isn't needed yet — could start as a
  simple keyword/description match over the registry (`getApp`/`listApps` in `../../src/core/registry.ts` already
  expose everything needed) and only grow into something fancier if the action count grows enough to
  matter, mirroring the "don't build for scale we don't have yet" discipline from `../../src/components/TODO.md`.

None of this is built. This doc exists so the shape is settled and citable when Phase-MCP actually starts.

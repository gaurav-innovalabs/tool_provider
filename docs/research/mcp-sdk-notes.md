# MCP TypeScript SDK — implementation notes (confirms mcp-connect-flow.md is buildable)

Addendum to `mcp-connect-flow.md` (which nailed the *shape* — meta-tools, user_id bound once, inline
connect-URL-as-result). This doc checks the *mechanics*: is there a real, current SDK to build that shape
with, and does it fit this project's Bun-only constraint (`../../CLAUDE.md`).

## The SDK

- `@modelcontextprotocol/sdk` — the official TypeScript SDK, `modelcontextprotocol/typescript-sdk` on
  GitHub. Current as of 2026-09: ~1.29.x, implements the 2025-11-25 MCP spec revision.
- Server API: `new McpServer({ name, version })`, then `server.registerTool(name, { description,
  inputSchema: <zod raw shape>, outputSchema? }, handler)`. Tools can be registered **dynamically at
  runtime** (not just at construction) — this is exactly what a `search_tools` → `execute_tool` meta-tool
  pair needs, though Phase-MCP-1 doesn't need dynamic registration at all (see below).
- Two transports matter here:
  - `StdioServerTransport` — the process's own stdin/stdout. This is what Claude Desktop/Claude Code spawn
    for a local MCP server entry (`"command": "bun", "args": ["mcp.ts"], "env": {...}`). **No auth
    mechanism of its own** — whoever can spawn the process IS the caller. `user_id`/`AuthKey` arrive as env
    vars set once in the client's MCP config, matching this project's existing `../../src/config.ts` pattern exactly.
  - `StreamableHTTPServerTransport` — a real network transport for a remote, multi-tenant server (many
    users hitting the same running process, Pipedream's model). Needs a Bearer-token resource-server setup
    (`requireBearerAuth`, `/.well-known/oauth-protected-resource` per RFC 9728) if done to spec — real
    work, not a small addition.
- **Open question, not resolved here**: whether the SDK's HTTP transport binds directly to Bun's
  `Request`/`Response` (`Bun.serve()`, per `../../CLAUDE.md` — no Express) or expects a Node
  `http.IncomingMessage`/`ServerResponse` pair. Historically it was Node-shaped; current docs/examples in
  the wild still mostly show it behind Express. **Needs a direct spike before Phase-MCP-2 is real** — not
  guessed at here. Tracked as a TODO in `../../MCP_GUIDE.md`.

## What this means for phasing

Because `StdioServerTransport` needs zero HTTP/auth-transport work and matches "`user_id` fixed once at
session/config time" even more directly than Composio's own model (env var, not an SDK session object),
it's the correct **Phase-MCP-1** target: real meta-tools, real auth-key check, zero unresolved transport
questions. Remote/multi-tenant HTTP hosting (many users, one long-lived process, header-based `user_id` —
the Pipedream shape) is **Phase-MCP-2**, gated on the Bun/`StreamableHTTPServerTransport` spike above.

Sources:
- [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [typescript-sdk/docs/server.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
</content>

// Phase-MCP-2: remote, multi-tenant MCP over HTTP. One long-lived server process, many concurrent users —
// unlike stdio (server.ts's createMcpServer), where one process = one user_id fixed at spawn time. Here
// user_id is resolved per HTTP session from a bearer token obtained via the browser login flow
// (loginRoutes.ts), matching Pipedream's "user_id travels as a header, set once in the client's remote-MCP
// config" shape — the only difference is where that credential comes from (a login page here, a raw
// external_user_id there).
//
// Built on WebStandardStreamableHTTPServerTransport (`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`)
// — its `handleRequest(req: Request): Promise<Response>` is Web Standard (Fetch API) shaped, confirmed
// against the SDK's own .d.ts to work directly with Bun.serve() routes, no Express/Node-http adapter
// needed. This resolves the open question left in docs/research/mcp-sdk-notes.md.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "./server";
import { resolveMcpLoginToken } from "../lib/mcpTokens";

interface McpHttpSession {
  transport: WebStandardStreamableHTTPServerTransport;
}

// In-memory only, per process — fine at this scale (matches src/core/scheduler.ts's per-instance lock
// TODO note: nothing here needs to survive a restart, a client just reconnects and re-initializes).
// TODO(ask): if this ever runs as more than one replica behind a load balancer, session affinity (sticky
// routing by mcp-session-id) or a shared session store becomes required — not needed at current scale.
const sessions = new Map<string, McpHttpSession>();

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  // Fallback: `?token=` query param — mirrors Pipedream's documented header-or-query-param flexibility
  // (docs/research/mcp-connect-flow.md), useful for MCP clients that only let you configure a URL, not headers.
  const url = new URL(req.url);
  return url.searchParams.get("token");
}

export async function handleMcpHttpRequest(req: Request): Promise<Response> {
  const sessionId = req.headers.get("mcp-session-id");

  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (!existing) {
      return Response.json({ error: "Unknown or expired MCP session" }, { status: 404 });
    }
    return existing.transport.handleRequest(req);
  }

  // No session id yet — this must be an initialize request. Resolve the caller's identity from their
  // login token before creating anything.
  const token = extractBearerToken(req);
  if (!token) {
    return Response.json({ error: "Missing bearer token — get one at /mcp/login" }, { status: 401 });
  }
  const payload = await resolveMcpLoginToken(token);
  if (!payload) {
    return Response.json({ error: "Invalid or unknown MCP token — get a new one at /mcp/login" }, { status: 401 });
  }

  const server = buildMcpServer(payload.user_id, payload.apps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport });
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

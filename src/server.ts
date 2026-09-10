// Bun.serve entrypoint. No express (per CLAUDE.md). Routes live in src/api/*_routes.ts, one file per
// concern (admin/user/connection/action/trigger/webhook) — this file only composes them. See
// src/api/webhook_routes.ts for why oauth_callback lives there and not in connection_routes.ts.
//
// Internal-only gating (was the TODO(ask) here): a single bearer-token wrapper (src/lib/apiAuth.ts),
// applied per route group below, NOT CORS — this API is meant to be called by our own client (or Swagger
// UI's same-origin "Authorize"), not from other browser origins, so there's no Access-Control-Allow-Origin
// to widen. Left un-gated, by design: webhookRoutes (external providers — Google/Slack — call these
// directly and can't attach our token), publicConnectRoutes' /connect/:token (an end user's browser opens
// it directly; it's already protected by its own single-use token), and mcpRoutes' /mcp/login + /mcp
// (the login form checks the same tokens itself, and /mcp authenticates each session with its own
// per-user MCP token — see src/mcp/httpServer.ts).

import { adminRoutes } from "./api/admin_routes";
import { userRoutes } from "./api/user_routes";
import { connectionRoutes, publicConnectRoutes } from "./api/connection_routes";
import { actionRoutes } from "./api/action_routes";
import { triggerRoutes } from "./api/trigger_routes";
import { webhookRoutes } from "./api/webhook_routes";
import { docsRoutes } from "./api/docs_routes";
import { mcpRoutes } from "./api/mcp_routes";
import { withAccessToken, withAdminAccessToken } from "./lib/apiAuth";
import { config } from "./config";

export function createServer() {
  return Bun.serve({
    port: config.PORT,
    routes: {
      ...withAdminAccessToken(adminRoutes),
      ...withAccessToken(userRoutes),
      ...withAccessToken(connectionRoutes),
      ...publicConnectRoutes,
      ...withAccessToken(actionRoutes),
      ...withAccessToken(triggerRoutes),
      ...webhookRoutes,
      ...withAccessToken(docsRoutes),
      ...mcpRoutes,
    },
    development: {
      hmr: true,
      console: true,
    },
  });
}

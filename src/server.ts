// Bun.serve entrypoint. No express (per CLAUDE.md). Routes live in src/api/*_routes.ts, one file per
// concern (admin/user/connection/action/trigger/webhook) — this file only composes them. See
// src/api/webhook_routes.ts for why oauth_callback lives there and not in connection_routes.ts.

import { adminRoutes } from "./api/admin_routes";
import { userRoutes } from "./api/user_routes";
import { connectionRoutes } from "./api/connection_routes";
import { actionRoutes } from "./api/action_routes";
import { triggerRoutes } from "./api/trigger_routes";
import { webhookRoutes } from "./api/webhook_routes";
import { docsRoutes } from "./api/docs_routes";
import { config } from "./config";

// TODO(ask): the .env.example has an `AuthKey` meant to restrict this server to internal callers only
// ("its not for public use for now"). Where does that check belong — a per-route-file check, or a single
// wrapper applied here around all routes except webhook_routes (which external providers call directly
// and can't attach our AuthKey to)?

export function createServer() {
  return Bun.serve({
    port: config.PORT,
    routes: {
      ...adminRoutes,
      ...userRoutes,
      ...connectionRoutes,
      ...actionRoutes,
      ...triggerRoutes,
      ...webhookRoutes,
      ...docsRoutes,
    },
    development: {
      hmr: true,
      console: true,
    },
  });
}

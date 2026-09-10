// Read-only, internal-only. "Nothing else" scoping per spec: /admin/users returns connection_id/app/status
// only, no secrets, no user_metadata dump. No separate core/admin.ts wrapper (removed: pure pass-through
// over the stores, route is the only caller).
//
// Gated with the stricter of the two bearer tokens — see server.ts, which wraps this whole group with
// withAdminAccessToken (src/lib/apiAuth.ts): the regular ACCESS_TOKEN is not accepted here, only
// ADMIN_ACCESS_TOKEN.

import { userStore, connectionStore, triggerInstanceStore, actionLogStore, triggerLogStore } from "../core/store";

export const adminRoutes = {
  "/admin/users": {
    GET: async () => {
      const users = await userStore.listAll();
      const rows = await Promise.all(
        users.map(async (user) => {
          const connections = await connectionStore.listByUser(user.user_id);
          return {
            user_id: user.user_id,
            connections: connections.map((c) => ({ connection_id: c.connection_id, app: c.app, status: c.status })),
          };
        }),
      );
      // TODO(ask): N+1 pattern (listAll users, then per-user connection lookup) — fine at Phase 1 in-memory
      // scale, worth a single join-style query once Phase 4 moves to Postgres.
      return Response.json(rows);
    },
  },
  "/admin/triggers": {
    GET: async () => {
      const instances = await triggerInstanceStore.listActive();
      return Response.json(
        instances.map((t) => ({
          trigger_instance_id: t.trigger_instance_id,
          user_id: t.user_id,
          app: t.app,
          trigger_key: t.trigger_key,
          status: t.status,
        })),
      );
    },
  },
  "/admin/logs": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const logs = await actionLogStore.listRecent(limit);
      return Response.json(
        logs.map((l) => ({ app: l.app, action_key: l.action_key, user_id: l.user_id, status: l.status, called_at: l.called_at })),
      );
    },
  },
  "/admin/trigger_logs": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const logs = await triggerLogStore.listRecent(limit);
      return Response.json(
        logs.map((l) => ({
          trigger_instance_id: l.trigger_instance_id,
          app: l.app,
          trigger_key: l.trigger_key,
          user_id: l.user_id,
          status: l.status,
          ran_at: l.ran_at,
          error: l.error,
          webhook_url: l.webhook_url,
          resendable: l.payload !== undefined,
        })),
      );
    },
  },
};

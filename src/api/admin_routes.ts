// Read-only, internal-only. "Nothing else" scoping per spec: /admin/users returns connection_id/app/status
// only, no credentials, no user_metadata dump. No separate core/admin.ts wrapper (removed: pure pass-through
// over the stores, route is the only caller).

import { userStore, connectionStore, triggerInstanceStore, actionLogStore } from "../core/store";

// TODO(ask): confirm gating — same AuthKey as the rest, or a stricter/separate admin key since this
// is meant for us to inspect the system, not for a client integration to call at all?

export const adminRoutes = {
  "/admin/users": {
    GET: async (req: Request) => {
      // TODO:
      // 1. users = userStore.listAll()
      // 2. for each, connections = connectionStore.listByUser(user.user_id)
      // 3. map to [{ user_id, connections: [{ connection_id, app, status }] }], return as JSON.
      // No pagination in Phase 1 (fine at low user counts) — TODO(ask) revisit if this becomes a real ops
      // tool vs. a dev-time debug endpoint.
      throw new Error("not implemented");
    },
  },
  "/admin/triggers": {
    GET: async (req: Request) => {
      // TODO: triggerInstanceStore.listActive(), map to [{ trigger_instance_id, user_id, app, trigger_key,
      // status }], return as JSON. Will be an empty array until Phase 3 lands.
      throw new Error("not implemented");
    },
  },
  "/admin/logs": {
    GET: async (req: Request) => {
      // TODO: parse ?limit= (default 50), call actionLogStore.listRecent(limit), map to [{ app, action_key,
      // user_id, status, called_at }], return JSON. Will be an empty array until Phase 2 wires
      // actionLogStore.append() into the action dispatcher.
      throw new Error("not implemented");
    },
  },
};

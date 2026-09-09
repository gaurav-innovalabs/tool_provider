// Redis client. Per CLAUDE.md: use Bun.redis, not `ioredis`.
//
// Two real uses now: (1) connect tokens below — the public URL a user opens to complete a connection
// (oauth2 redirect or api_key field-collection form) is a random Redis-backed token, never the raw
// connection_id, matching the pattern in /home/gr/projects/backend's integration_routes.py
// (`cache.app.set_async(f"composio:connect:{token}", ...)`). (2) Phase 3 trigger scheduler locking,
// below — not called anywhere yet.
//
// Bun.redis reads its connection string from `REDIS_URL` (or `VALKEY_URL`) automatically — added to
// .env.example.

export const redis = Bun.redis;

const CONNECT_TOKEN_PREFIX = "connect_token:";
const CONNECT_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour — matches the ttl=3600 pattern in the backend reference

// Maps a short-lived public token -> connection_id. The token, not the connection_id, is what ever
// appears in a URL handed to an end user — see connection_routes.ts's POST /connections and the new
// GET/POST /connect/:token routes.
export async function createConnectToken(connectionId: string): Promise<string> {
  const token = crypto.randomUUID();
  await redis.set(`${CONNECT_TOKEN_PREFIX}${token}`, connectionId, "EX", CONNECT_TOKEN_TTL_SECONDS);
  return token;
}

export async function resolveConnectToken(token: string): Promise<string | null> {
  return await redis.get(`${CONNECT_TOKEN_PREFIX}${token}`);
}

// Called once a connection actually completes (or permanently fails) — a used/expired token must not be
// reusable, same reasoning as the backend reference calling `cache.delete(cache_key)` after its callback.
export async function deleteConnectToken(token: string): Promise<void> {
  await redis.del(`${CONNECT_TOKEN_PREFIX}${token}`);
}

// TODO(ask): what specifically needs Redis vs. just living in Postgres (db.ts)? Concrete candidate uses,
// not yet decided which are actually needed:
// - Phase 3 trigger scheduler: a per-trigger-instance lock so two scheduler ticks (or two server instances,
//   once this isn't single-process) don't poll the same Gmail/Slack connection concurrently and race on the
//   cursor. This is the one Redis is actually good for that Postgres isn't (a simple TTL'd lock key).
// - Rate-limit bookkeeping per connection (e.g. Gmail/Slack API quota) — TBD if needed at Phase 1-3 scale.
// - NOT the cursor/historyId itself, or connection/user data — those are durable records, belong in
//   Postgres (db.ts), not a cache that can be evicted.

export async function acquireTriggerLock(_triggerInstanceId: string, _ttlMs: number): Promise<boolean> {
  // TODO: `redis.set(key, "1", "NX", "PX", ttlMs)`-equivalent, return whether the lock was acquired.
  // Used by the Phase 3 scheduler, not called anywhere yet.
  throw new Error("not implemented");
}

export async function releaseTriggerLock(_triggerInstanceId: string): Promise<void> {
  throw new Error("not implemented");
}

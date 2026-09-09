// Redis client. Per CLAUDE.md: use Bun.redis, not `ioredis`. Just the core client init — connect tokens
// below are the only real use. The public URL a user opens to complete a connection (oauth2 redirect or
// api_key field-collection form) is a random Redis-backed token, never the raw connection_id, matching the
// pattern in /home/gr/projects/backend's integration_routes.py (`cache.app.set_async(f"composio:connect:{token}", ...)`).
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

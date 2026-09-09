// Long-lived MCP login tokens — separate from lib/redis.ts's connect tokens (those are single-use,
// 1-hour, "open this URL once to finish an OAuth/api_key connect"). This token is the opposite shape: the
// caller pastes it once into an MCP client's config/UI and reuses it on every request indefinitely, the
// same way a Composio/Pipedream remote-MCP bearer token works. No TTL — it's a credential, not a link.
// Revocation isn't built yet (see MCP_GUIDE.md's Phase-MCP-2 TODOs) — `redis.del` is there if/when needed.

import { redis } from "./redis";

const MCP_TOKEN_PREFIX = "mcp_login_token:";

export interface McpTokenPayload {
  user_id: string;
  // App-scoping (src/mcp/metaTools.ts's AppScope) chosen at login time — null/absent means every app in
  // the registry is visible to this session, same as before app-scoping existed.
  apps: string[] | null;
}

export async function createMcpLoginToken(payload: McpTokenPayload): Promise<string> {
  const token = crypto.randomUUID();
  await redis.set(`${MCP_TOKEN_PREFIX}${token}`, JSON.stringify(payload));
  return token;
}

export async function resolveMcpLoginToken(token: string): Promise<McpTokenPayload | null> {
  const raw = await redis.get(`${MCP_TOKEN_PREFIX}${token}`);
  if (!raw) return null;
  // Tokens minted before app-scoping existed stored the bare user_id string, not JSON — handle both so an
  // already-issued token doesn't silently break.
  try {
    return JSON.parse(raw) as McpTokenPayload;
  } catch {
    return { user_id: raw, apps: null };
  }
}

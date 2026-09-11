// Minimal MCP-spec OAuth 2.1 authorization server (RFC 7591 dynamic client registration + RFC 7636 PKCE
// authorization code flow) — just enough for a spec-compliant remote-MCP client (Claude Code, Claude
// Desktop, etc.) to go from "here's a bare URL, no header, no env var" to a working session entirely on
// its own: register itself, bounce the user to our existing /oauth/authorize login form (same user_id +
// access_key fields as /mcp/login, see src/api/mcp_routes.ts), and exchange the resulting code for the
// same long-lived bearer token src/lib/mcpTokens.ts already mints. This is the piece MCP_GUIDE.md called
// "Explicitly deferred" — now built because a real client (Claude Code) needs it to avoid a hardcoded
// token in its own config, matching how Composio/Pipedream's hosted connectors behave (no static secret
// baked into the MCP client, session auth resolved dynamically).
//
// Deliberately NOT using the SDK's server/auth/* (mcpAuthRouter etc.) — those are Express-shaped
// (req: express.Request), this project has no Express (CLAUDE.md: use Bun.serve()). Implemented directly
// against Bun.serve()'s Request/Response instead, same pattern as every other src/api/*_routes.ts file.
//
// Storage: Redis, same primitive as lib/redis.ts's connect tokens — a client registration has no
// expiry (a client re-registers rarely, per-install), an authorization code is single-use with a short
// TTL (it only has to survive one browser redirect).

import { redis } from "./redis";

const CLIENT_PREFIX = "oauth_client:";
const CODE_PREFIX = "oauth_code:";
const CODE_TTL_SECONDS = 5 * 60; // just long enough for the login form round-trip

export interface OAuthClient {
  client_id: string;
  redirect_uris: string[];
}

export async function registerClient(redirectUris: string[]): Promise<OAuthClient> {
  const client_id = crypto.randomUUID();
  const client: OAuthClient = { client_id, redirect_uris: redirectUris };
  await redis.set(`${CLIENT_PREFIX}${client_id}`, JSON.stringify(client));
  return client;
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const raw = await redis.get(`${CLIENT_PREFIX}${clientId}`);
  return raw ? (JSON.parse(raw) as OAuthClient) : null;
}

export interface PendingAuthCode {
  user_id: string;
  apps: string[] | null;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
}

export async function createAuthCode(payload: PendingAuthCode): Promise<string> {
  const code = crypto.randomUUID();
  await redis.set(`${CODE_PREFIX}${code}`, JSON.stringify(payload), "EX", CODE_TTL_SECONDS);
  return code;
}

// Single-use — deleted on first read regardless of whether verification later succeeds, same "a used
// token must not be reusable" reasoning as lib/redis.ts's deleteConnectToken.
export async function consumeAuthCode(code: string): Promise<PendingAuthCode | null> {
  const raw = await redis.get(`${CODE_PREFIX}${code}`);
  if (!raw) return null;
  await redis.del(`${CODE_PREFIX}${code}`);
  return JSON.parse(raw) as PendingAuthCode;
}

// RFC 7636 S256: base64url(SHA256(code_verifier)) === code_challenge.
export async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const computed = Buffer.from(digest).toString("base64url");
  return computed === codeChallenge;
}

// Gates the REST API to internal callers only (resolves the TODO(ask) that used to live in server.ts /
// config.ts) — NOT CORS. This is a server-to-server (or Swagger-UI-same-origin) API, not a public
// browser API, so there's no "Access-Control-Allow-Origin" to widen; the fix for "who can call this" is
// a bearer token, same shape as the MCP remote-HTTP flow (src/mcp/httpServer.ts's extractBearerToken) —
// one unified pattern, not two.
//
// Two static, env-configured tokens (src/config.ts): ACCESS_TOKEN works on every gated route.
// ADMIN_ACCESS_TOKEN additionally unlocks /admin/*. Neither is per-user or expiring — that's the whole
// point of "not fancy for now" (unlike the MCP login token in src/lib/mcpTokens.ts, which is per-user).

import { config } from "../config";

// Header, or `?token=` query param — same fallback as extractBearerToken in src/mcp/httpServer.ts, so a
// tool that can only set a URL (e.g. opening /docs?token=... directly in a browser) still works.
function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const url = new URL(req.url);
  return url.searchParams.get("token");
}

function unauthorized(message: string) {
  return Response.json({ error: message }, { status: 401 });
}

function isAccessToken(token: string): boolean {
  return token === config.security.ACCESS_TOKEN || token === config.security.ADMIN_ACCESS_TOKEN;
}

function isAdminAccessToken(token: string): boolean {
  return token === config.security.ADMIN_ACCESS_TOKEN;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any) => Response | Promise<Response>;
type RouteGroup = Record<string, Record<string, Handler>>;

function wrap(routes: RouteGroup, isAllowed: (token: string) => boolean, deniedMessage: string): RouteGroup {
  const wrapped: RouteGroup = {};
  for (const [path, methods] of Object.entries(routes)) {
    const wrappedMethods: Record<string, Handler> = {};
    for (const [method, handler] of Object.entries(methods)) {
      wrappedMethods[method] = async (req: Request) => {
        const token = extractBearerToken(req);
        if (!token) return unauthorized("Missing bearer token — pass 'Authorization: Bearer <token>' or '?token=<token>'.");
        if (!isAllowed(token)) return Response.json({ error: deniedMessage }, { status: 403 });
        return handler(req);
      };
    }
    wrapped[path] = wrappedMethods;
  }
  return wrapped;
}

// ACCESS_TOKEN or ADMIN_ACCESS_TOKEN — normal internal callers (our own client, Swagger UI "Authorize").
export function withAccessToken<T extends RouteGroup>(routes: T): T {
  return wrap(routes, isAccessToken, "Invalid bearer token.") as T;
}

// ADMIN_ACCESS_TOKEN only.
export function withAdminAccessToken<T extends RouteGroup>(routes: T): T {
  return wrap(routes, isAdminAccessToken, "This route requires the admin bearer token.") as T;
}

// Swagger UI, served entirely from local static assets (swagger-ui-dist) — no CDN dependency.
// /openapi.json is the spec (src/openapi.ts). /docs is the Swagger UI page. /docs/* serves the
// swagger-ui-dist bundle assets it references (js/css/png) — left ungated since they're just the
// generic Swagger UI library, not anything specific to this API.
//
// /docs and /openapi.json ARE gated (this API is internal-only), but a plain browser navigation to
// /docs can't set an Authorization header, so the gate can't be the generic withAccessToken 401-JSON
// wrap used elsewhere (see server.ts). Instead the token is collected ONCE, via a real <form method="POST">
// to /docs/login (no ?token= anywhere — never in a URL, browser history, or Referer header), and checked
// server-side against a plain HttpOnly cookie (docs_session) from then on. That cookie's only job is
// getting you past this /docs barrier and letting the browser's own same-origin fetch of /openapi.json
// succeed so Swagger UI has a spec to render. It is NOT wired into Swagger UI's own request pipeline —
// no requestInterceptor, no preauthorizeApiKey. Once the page loads, Swagger UI's own "Authorize" dialog
// is the only thing that controls the Authorization header on "Try it out" calls: paste a token, change
// it, or hit its own Logout, all independent of this cookie. "Change access token" (top-right) clears the
// cookie and sends you back to the login form — it has no effect on Swagger UI's own auth state, and vice
// versa.

import { openApiSpec } from "../openapi";
import { isAccessToken } from "../lib/apiAuth";

const SWAGGER_UI_DIR = new URL("../../node_modules/swagger-ui-dist/", import.meta.url);
const COOKIE_NAME = "docs_session";

function htmlResponse(body: string, extraHeaders?: Record<string, string>) {
  // no-store: without this the browser can serve a cached copy of an already-authenticated /docs page
  // on refresh or back-navigation instead of re-checking with the server.
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders } });
}

function readHeaderToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

function readCookieToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function setCookieHeader(req: Request, token: string): string {
  const secure = new URL(req.url).protocol === "https:" ? " Secure;" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly;${secure} SameSite=Lax; Path=/`;
}

function clearCookieHeader(req: Request): string {
  const secure = new URL(req.url).protocol === "https:" ? " Secure;" : "";
  return `${COOKIE_NAME}=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0`;
}

const LOGIN_HTML = (invalidAttempt: boolean) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>tool_provider_project API docs</title>
  </head>
  <body>
    ${invalidAttempt ? "<p>Invalid token.</p>" : ""}
    <form method="POST" action="/docs/login">
      <label>API access token: <input type="password" name="token" autofocus /></label>
      <button type="submit">Enter</button>
    </form>
  </body>
</html>
`;

const DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>tool_provider_project API docs</title>
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
    <style>body { margin: 0; }</style>
  </head>
  <body>
    <div style="text-align: right; padding: 4px 8px; font: 12px sans-serif">
      <a href="/docs/logout">Change access token</a>
    </div>
    <div id="swagger-ui"></div>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script src="/docs/swagger-ui-standalone-preset.js"></script>
    <script>
      window.onload = function () {
        window.ui = SwaggerUIBundle({
          url: "/openapi.json",
          dom_id: "#swagger-ui",
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          plugins: [SwaggerUIBundle.plugins.DownloadUrl],
          layout: "StandaloneLayout",
        });
      };
    </script>
  </body>
</html>
`;

// Not wrapped with withAccessToken (see file header) — validates the docs_session cookie itself so it
// can serve an HTML login form instead of a JSON 401.
export const docsPageRoutes = {
  "/docs": {
    GET: (req: Request) => {
      const token = readCookieToken(req);
      if (token && isAccessToken(token)) return htmlResponse(DOCS_HTML);
      return htmlResponse(LOGIN_HTML(!!token));
    },
  },
  "/docs/login": {
    POST: async (req: Request) => {
      const form = await req.formData();
      const token = String(form.get("token") ?? "");
      if (!token || !isAccessToken(token)) return htmlResponse(LOGIN_HTML(true), { "Set-Cookie": clearCookieHeader(req) });
      return new Response(null, { status: 303, headers: { Location: "/docs", "Set-Cookie": setCookieHeader(req, token) } });
    },
  },
  "/docs/logout": {
    GET: (req: Request) => new Response(null, { status: 303, headers: { Location: "/docs", "Set-Cookie": clearCookieHeader(req) } }),
  },
};

// /openapi.json needs to work two ways: the browser's own same-origin fetch from inside /docs (the
// docs_session cookie, set once at login above) and a real API client sending a normal Authorization
// header — no ?token= query param accepted here (or anywhere in this docs flow).
export const openApiRoutes = {
  "/openapi.json": {
    GET: (req: Request) => {
      const token = readCookieToken(req) ?? readHeaderToken(req);
      if (!token) return Response.json({ error: "Missing bearer token — pass 'Authorization: Bearer <token>'." }, { status: 401 });
      if (!isAccessToken(token)) return Response.json({ error: "Invalid bearer token." }, { status: 401 });
      return Response.json(openApiSpec);
    },
  },
};

// Ungated — just the swagger-ui-dist static bundle (js/css/png), not app-specific.
export const docsAssetRoutes = {
  "/docs/*": {
    GET: (req: Request) => {
      const path = new URL(req.url).pathname.replace(/^\/docs\//, "");
      // No "..", no absolute paths — path is only ever a flat asset name from swagger-ui-dist.
      if (path.includes("..") || path.includes("/")) return new Response("Not found", { status: 404 });
      const file = Bun.file(new URL(path, SWAGGER_UI_DIR));
      return file.exists().then((ok) => (ok ? new Response(file) : new Response("Not found", { status: 404 })));
    },
  },
};

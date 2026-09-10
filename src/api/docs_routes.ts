// Swagger UI, served entirely from local static assets (swagger-ui-dist) — no CDN dependency.
// /openapi.json is the spec (src/openapi.ts). /docs is the Swagger UI page. /docs/* serves the
// swagger-ui-dist bundle assets it references (js/css/png) — left ungated since they're just the
// generic Swagger UI library, not anything specific to this API.
//
// /docs and /openapi.json ARE gated (this API is internal-only), but a plain browser navigation to
// /docs can't set an Authorization header, so the gate can't be the generic withAccessToken 401-JSON
// wrap used elsewhere (see server.ts) — that would make /docs permanently unreachable without already
// knowing to append ?token=. Instead /docs checks the token itself (extractBearerToken/isAccessToken
// from src/lib/apiAuth.ts) and, when it's missing or wrong, serves a tiny login page instead of the
// Swagger UI: that page reads a previously-saved token from localStorage, or window.prompt()s for one,
// then redirects to /docs?token=<value> for the server to validate. Once validated, the real page moves
// the token from the URL into localStorage and strips it from the address bar via history.replaceState
// (so it doesn't linger in browser history), then attaches it as the Authorization header on every
// request Swagger UI makes (including its own fetch of /openapi.json, which is wrapped with
// withAccessToken like the rest of the API) via requestInterceptor, and preauthorizes Swagger UI's own
// "Authorize" dialog so it shows as already filled in. "Change access token" clears the cached value and
// sends you back to the login page. This is same-origin, so there's no CORS to configure — the earlier
// "Failed to fetch" in Swagger UI was a missing-auth-header/network issue, not a CORS one, and adding
// Access-Control-Allow-Origin would only widen who can call this, the opposite of what's wanted here.

import { openApiSpec } from "../openapi";
import { extractBearerToken, isAccessToken } from "../lib/apiAuth";

const SWAGGER_UI_DIR = new URL("../../node_modules/swagger-ui-dist/", import.meta.url);

function htmlResponse(body: string) {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const LOGIN_HTML = (invalidAttempt: boolean) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>tool_provider_project API docs</title>
  </head>
  <body>
    <script>
      var TOKEN_KEY = "tool_provider_access_token";
      var invalidAttempt = ${invalidAttempt ? "true" : "false"};
      if (invalidAttempt) localStorage.removeItem(TOKEN_KEY);
      var token = invalidAttempt ? null : localStorage.getItem(TOKEN_KEY);
      if (!token) {
        token = window.prompt(invalidAttempt ? "Invalid token. Enter API access token:" : "Enter API access token:");
      }
      if (token) {
        location.href = "/docs?token=" + encodeURIComponent(token);
      } else {
        document.body.textContent = "Access token required.";
      }
    </script>
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
      <a href="#" onclick="forgetApiToken(); return false;">Change access token</a>
    </div>
    <div id="swagger-ui"></div>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script src="/docs/swagger-ui-standalone-preset.js"></script>
    <script>
      var TOKEN_KEY = "tool_provider_access_token";
      var params = new URLSearchParams(location.search);
      var urlToken = params.get("token");
      var token = urlToken || localStorage.getItem(TOKEN_KEY);
      if (urlToken) {
        localStorage.setItem(TOKEN_KEY, urlToken);
        history.replaceState({}, "", "/docs");
      }

      window.onload = function () {
        window.ui = SwaggerUIBundle({
          url: "/openapi.json",
          dom_id: "#swagger-ui",
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          plugins: [SwaggerUIBundle.plugins.DownloadUrl],
          layout: "StandaloneLayout",
          requestInterceptor: function (req) {
            if (token) req.headers["Authorization"] = "Bearer " + token;
            return req;
          },
          onComplete: function () {
            if (token) window.ui.preauthorizeApiKey("bearerAuth", token);
          },
        });
      };

      window.forgetApiToken = function () {
        localStorage.removeItem(TOKEN_KEY);
        location.href = "/docs";
      };
    </script>
  </body>
</html>
`;

// Not wrapped with withAccessToken (see file header) — validates the token itself so it can serve an
// HTML login page instead of a JSON 401.
export const docsPageRoutes = {
  "/docs": {
    GET: (req: Request) => {
      const token = extractBearerToken(req);
      if (token && isAccessToken(token)) return htmlResponse(DOCS_HTML);
      return htmlResponse(LOGIN_HTML(!!token));
    },
  },
};

// Wrapped with withAccessToken in server.ts, like the rest of the internal API.
export const openApiRoutes = {
  "/openapi.json": {
    GET: () => Response.json(openApiSpec),
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

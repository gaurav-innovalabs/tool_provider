// Swagger UI, served entirely from local static assets (swagger-ui-dist) — no CDN dependency.
// /openapi.json is the spec (src/openapi.ts). /docs is the Swagger UI page. /docs/* serves the
// swagger-ui-dist bundle assets it references (js/css/png). Not gated by the AuthKey question in
// server.ts (TODO(ask) there) — this is documentation, not a data-bearing route.

import { openApiSpec } from "../openapi";

const SWAGGER_UI_DIR = new URL("../../node_modules/swagger-ui-dist/", import.meta.url);

const DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>tool_provider_project API docs</title>
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
    <style>body { margin: 0; }</style>
  </head>
  <body>
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

export const docsRoutes = {
  "/openapi.json": {
    GET: () => Response.json(openApiSpec),
  },
  "/docs": {
    GET: () => new Response(DOCS_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
  },
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

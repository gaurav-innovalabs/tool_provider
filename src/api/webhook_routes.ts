// Everything an EXTERNAL service calls on us (as opposed to every other *_routes.ts file, which our own
// client calls). Grouped together deliberately: OAuth callback (Google/Slack redirect the user's browser
// here after consent) and inbound trigger webhooks (a third party pushing an event to us, Phase 6 per
// research/triggers-patterns.md) are the same *shape* of endpoint even though they serve different
// purposes — unauthenticated-by-us, provider-initiated, need their own verification per provider.
//
// Result page uses the same shared visual shell as the api_key connect form (src/lib/connectPage.ts) —
// so an oauth2 callback and an api_key connect end up looking like one product, not two.

import { connectionStore } from "../core/store";
import { getApp } from "../core/registry";
import { exchangeCodeForToken } from "../lib/oauth";
import { successPage, errorPage } from "../lib/connectPage";

export const webhookRoutes = {
  "/oauth/callback/:app": {
    GET: async (req: Request & { params: { app: string } }) => {
      const url = new URL(req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state"); // connection_id
      const providerError = url.searchParams.get("error"); // e.g. user clicked "deny" on the consent screen

      if (providerError) {
        return errorPage(`Provider returned an error: ${providerError}`);
      }
      if (!code || !state) {
        return errorPage("Missing code or state in callback — this link may be malformed or already used.");
      }

      const connection = await connectionStore.get(state);
      if (!connection) {
        return errorPage("Unknown or expired connection — try connecting again.");
      }
      if (connection.app !== req.params.app) {
        // Defends against a state token being replayed against the wrong app's callback URL.
        return errorPage("App mismatch between the connect request and this callback.");
      }

      try {
        const app = getApp(req.params.app);
        if (app.auth.type !== "oauth2") {
          // This route only exists for oauth2 apps (api_key apps go straight to "active" in
          // connection_routes.ts, never through here) — reachable only if something hits this URL for the
          // wrong app, not a real flow.
          return errorPage(`App "${app.id}" doesn't use an OAuth callback (auth type: ${app.auth.type}).`);
        }
        const secrets = await exchangeCodeForToken(app.auth, app.id, code);
        await connectionStore.update(connection.connection_id, {
          status: "active",
          secrets,
          updated_at: new Date().toISOString(),
        });
        return successPage(app.name);
      } catch (err) {
        await connectionStore.update(connection.connection_id, {
          status: "error",
          updated_at: new Date().toISOString(),
        });
        return errorPage(err instanceof Error ? err.message : String(err));
      }
    },
  },

  // TODO(ask): Phase 6 inbound trigger webhook — not wired yet (no trigger in Phase 1-3 uses mode:
  // "webhook", Gmail/Slack triggers are both poll-based per src/components/*/triggers/*.ts). Shape TBD
  // per research/triggers-patterns.md's open fork: single fan-in path like "/webhooks/:app" (one per
  // consumer, signed, payload self-describes which trigger instance) vs. one path per trigger instance.
  // Adding the route here once that's decided — deliberately not stubbing a guess now.
};

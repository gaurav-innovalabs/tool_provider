// Connection lifecycle. POST /connections ALWAYS returns the same shape regardless of auth type — just
// { connection_id, status, connect_url } — never secrets, never a required_fields blob for the caller to
// render themselves. `connect_url` is a Redis-backed, single-use, short-lived token (never the raw
// connection_id — see src/lib/redis.ts), matching the `composio:connect:{token}` pattern in
// /home/gr/projects/backend's integration_routes.py/webhook/__init__.py.
//
// Opening that URL (GET /connect/:token):
//   - oauth2 apps  -> 302 redirect straight to the provider's real consent screen (Google/Slack).
//   - api_key apps -> WE serve the field-collection form (plain HTML, no JS) — the API caller/agent never
//     builds any UI. Submitting it (POST /connect/:token, same token) runs the App's real testConnection()
//     before activating; a bad value re-renders the same form with the real provider error.
// The oauth2 provider-callback half (Google/Slack calling us back after consent) lives in
// webhook_routes.ts, not here — see that file's header comment for why.

import { z } from "zod";
import { connectionStore } from "../core/store";
import { getApp } from "../core/registry";
import { buildAuthorizeUrl } from "../lib/oauth";
import { createConnectToken, resolveConnectToken, deleteConnectToken } from "../lib/redis";
import { config } from "../config";
import { PENDING_CONNECTION_TTL_MS } from "../core/connectionExpiry";
import { errorPage, successPage, fieldFormPage as renderFieldFormPage } from "../lib/connectPage";
import type { AppDefinition, Connection } from "../types";

const requestBody = z.object({
  user_id: z.string(),
  app: z.string(),
  extra_metadata: z.record(z.string(), z.unknown()).optional(),
});

// Never hand back real secrets over this API — connection status is public-ish (a client polls it to know
// when to stop showing "connecting..."), the tokens/api_key inside `secrets` are not. `extra_metadata` is
// fine to return — it was never a secret in the first place.
function redact(connection: Connection) {
  const { secrets, ...rest } = connection;
  return rest;
}

// Thin wrapper around src/lib/connectPage.ts's generic form renderer — this file just knows the app's
// auth-config shape (fields) and the URL to post to; the page's visual design lives in one shared place.
function fieldFormPage(app: AppDefinition, token: string, errorMessage?: string): Response {
  if (app.auth.type !== "api_key") {
    throw new Error(`fieldFormPage called for non-api_key app "${app.id}"`);
  }
  return renderFieldFormPage({
    appName: app.name,
    fields: app.auth.fields,
    actionUrl: `/connect/${token}`,
    errorMessage,
  });
}

// Client-facing, internal-only — gated with the bearer token in server.ts (src/lib/apiAuth.ts).
export const connectionRoutes = {
  "/connections": {
    // Client-facing "which connections have I created" — ~ Composio's GET /connected_accounts (filtered to
    // one user, since we have no admin-only "list every connection across every user" concept on this
    // route; that's GET /admin/users instead). Closes half of tool_provider.http's documented
    // "List/delete/disable a Connection" gap — list existed nowhere before this, not even admin-side beyond
    // the nested shape GET /admin/users already returns.
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const user_id = url.searchParams.get("user_id");
      if (!user_id) {
        return Response.json({ error: "user_id query param is required" }, { status: 400 });
      }
      const app = url.searchParams.get("app") ?? undefined;
      const connections = await connectionStore.listByUser(user_id, app);
      return Response.json({ connections: connections.map(redact) });
    },

    POST: async (req: Request) => {
      try {
        const body = requestBody.parse(await req.json());
        const app = getApp(body.app); // throws on unknown app — caught below as a 500; see registry.ts TODO on a typed 404 instead

        const connection_id = `conn_${crypto.randomUUID()}`;
        const now = new Date().toISOString();
        const extra_metadata = body.extra_metadata ?? {};

        if (app.auth.type === "oauth2" || app.auth.type === "api_key") {
          await connectionStore.create({
            connection_id,
            user_id: body.user_id,
            app: body.app,
            status: "pending",
            secrets: null,
            extra_metadata,
            expires_at: new Date(Date.now() + PENDING_CONNECTION_TTL_MS).toISOString(),
            created_at: now,
            updated_at: now,
          });

          // Same shape for both auth types — a random, short-lived token, never the raw connection_id.
          // What that token actually DOES once opened differs (redirect vs. form), but the caller never
          // needs to know which — it just gets a URL to hand to the end user.
          const token = await createConnectToken(connection_id);
          const connect_url = `${config.BASE_URL}/connect/${token}`;
          return Response.json({ connection_id, status: "pending", connect_url, app: app.id }, { status: 201 });
        }

        if (app.auth.type === "none") {
          // No secret to collect, no redirect — "connect" is just creating the row so every other route
          // (actions, admin) still has a normal connection_id to key off of, uniformly across every app.
          await connectionStore.create({
            connection_id,
            user_id: body.user_id,
            app: body.app,
            status: "active",
            secrets: null,
            extra_metadata,
            expires_at: null,
            created_at: now,
            updated_at: now,
          });
          return Response.json({ connection_id, status: "active", app: app.id }, { status: 201 });
        }

        // "custom" auth type: declared in the AppAuthConfig union (types.ts) but no app uses it yet.
        return Response.json({ error: `Auth type "${app.auth.type}" has no connect flow implemented yet` }, { status: 501 });
      } catch (err) {
        const status = err instanceof z.ZodError ? 400 : 500;
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
      }
    },
  },

  "/connections/:id": {
    GET: async (req: Request & { params: { id: string } }) => {
      const connection = await connectionStore.get(req.params.id);
      if (!connection) {
        return Response.json({ error: `Unknown connection: ${req.params.id}` }, { status: 404 });
      }
      return Response.json(redact(connection));
    },
  },
};

// Public, browser-visited, NOT gated by the bearer token — the ONE url handed out by POST /connections
// above, for either auth type. An end user's browser opens this directly and has no way to attach our
// internal Authorization header; it's already protected by its own single-use, short-lived Redis token
// (src/lib/redis.ts), which is the actual auth boundary here.
export const publicConnectRoutes = {
  "/connect/:token": {
    GET: async (req: Request & { params: { token: string } }) => {
      const connectionId = await resolveConnectToken(req.params.token);
      if (!connectionId) {
        return errorPage("This link has expired or was already used — request a new connection.");
      }
      const connection = await connectionStore.get(connectionId);
      if (!connection) {
        return errorPage("Connection no longer exists.");
      }
      if (connection.status !== "pending") {
        return errorPage(`This connection is already ${connection.status}.`);
      }

      const app = getApp(connection.app);
      if (app.auth.type === "oauth2") {
        const authorizeUrl = buildAuthorizeUrl(app.auth, app.id, connection.connection_id);
        return Response.redirect(authorizeUrl, 302);
      }
      if (app.auth.type === "api_key") {
        return fieldFormPage(app, req.params.token);
      }
      return errorPage(`Auth type "${app.auth.type}" has no connect page yet.`);
    },

    POST: async (req: Request & { params: { token: string } }) => {
      const connectionId = await resolveConnectToken(req.params.token);
      if (!connectionId) {
        return errorPage("This link has expired or was already used — request a new connection.");
      }
      const connection = await connectionStore.get(connectionId);
      if (!connection) {
        return errorPage("Connection no longer exists.");
      }
      if (connection.status !== "pending") {
        return errorPage(`This connection is already ${connection.status}.`);
      }

      const app = getApp(connection.app);
      if (app.auth.type !== "api_key" && app.auth.type !== "custom") {
        return errorPage(`Auth type "${app.auth.type}" doesn't accept field submission.`);
      }

      const form = await req.formData();
      const secrets: Record<string, string> = {};

      if (app.auth.type === "api_key") {
        for (const field of app.auth.fields) {
          const value = form.get(field.name);
          secrets[field.name] = typeof value === "string" ? value : "";
        }
        const missing = app.auth.fields.filter((f) => f.required && !secrets[f.name]);
        if (missing.length > 0) {
          return fieldFormPage(app, req.params.token, `Missing required field(s): ${missing.map((f) => f.name).join(", ")}`);
        }
      }

      // The real point of this step: don't trust submitted values just because the form was filled in —
      // actually call the provider before flipping the connection to active.
      if (app.testConnection) {
        try {
          await app.testConnection(secrets);
        } catch (err) {
          // Re-render the same form with the real provider error, token still valid — the user can retry.
          return app.auth.type === "api_key"
            ? fieldFormPage(app, req.params.token, err instanceof Error ? err.message : String(err))
            : errorPage(err instanceof Error ? err.message : String(err));
        }
      }

      await connectionStore.update(connection.connection_id, {
        status: "active",
        secrets,
        updated_at: new Date().toISOString(),
      });
      await deleteConnectToken(req.params.token); // single-use — done, can't be reopened/resubmitted

      return successPage(app.name);
    },
  },
};

// Browser-facing "MCP login" (GET/POST /mcp/login) + the remote MCP protocol endpoint itself
// (GET/POST/DELETE /mcp). Grouped together like webhook_routes.ts groups oauth_callback + inbound
// webhooks — both are "the MCP front door", one half is a human filling a form, the other half is an
// MCP client speaking JSON-RPC, but they're one concern (Phase-MCP-2) split across two file-level route
// groups for readability, not two files.

import { z } from "zod";
import { userStore } from "../core/store";
import { createMcpLoginToken, resolveMcpLoginToken } from "../lib/mcpTokens";
import { config } from "../config";
import { mcpLoginFormPage, mcpLoginSuccessPage, connectionsStatusPage, errorPage } from "../lib/connectPage";
import { handleMcpHttpRequest } from "../mcp/httpServer";
import { getApp, listApps } from "../core/registry";
import { manageConnection, listConnections, disconnectConnection } from "../mcp/metaTools";
import { formatError } from "../lib/errors";

const loginBody = z.object({
  access_key: z.string(),
  // Optional — an existing `usr_...` from a prior login, so the caller can reconnect as the SAME identity
  // (same connections) instead of every login minting a brand-new User. Blank/omitted keeps the old
  // behavior: always create a fresh user.
  user_id: z.string().optional(),
  // Comma-separated app ids, optional — matches stdio's MCP_APPS env var (src/mcp/server.ts). Empty/unset
  // means every app in the registry, same as before app-scoping existed.
  apps: z.string().optional(),
});

export const mcpRoutes = {
  "/mcp/login": {
    GET: async () => mcpLoginFormPage({}),
    POST: async (req: Request) => {
      let body: z.infer<typeof loginBody>;
      try {
        const form = await req.formData();
        body = loginBody.parse({
          access_key: form.get("access_key"),
          user_id: form.get("user_id") || undefined,
          apps: form.get("apps") || undefined,
        });
      } catch {
        return mcpLoginFormPage({ errorMessage: "Access key is required." });
      }

      // Same unified bearer tokens as the REST API (src/lib/apiAuth.ts) — either one gets you an MCP login.
      if (body.access_key !== config.security.ACCESS_TOKEN && body.access_key !== config.security.ADMIN_ACCESS_TOKEN) {
        return mcpLoginFormPage({ errorMessage: "That access key isn't valid.", userId: body.user_id, apps: body.apps });
      }

      try {
        const requestedUserId = body.user_id?.trim();
        let user_id: string;
        let reused: boolean;
        if (requestedUserId) {
          // Log back in as an existing identity instead of always minting a fresh User — this is what
          // lets a client "close and reopen" without losing its connections (same user_id -> same
          // connection rows). Reject an unknown/typo'd id instead of silently creating a new user under
          // it, so a bad paste is caught here, not three tool calls later as "why are my connections gone".
          const existing = await userStore.get(requestedUserId);
          if (!existing) {
            return mcpLoginFormPage({ errorMessage: `Unknown user ID "${requestedUserId}" — leave blank to create a new one.`, apps: body.apps });
          }
          user_id = existing.user_id;
          reused = true;
        } else {
          user_id = `usr_${crypto.randomUUID()}`;
          await userStore.create({ user_id, user_metadata: { source: "mcp_login" }, created_at: new Date().toISOString() });
          reused = false;
        }
        const apps = body.apps?.trim() ? body.apps.split(",").map((a) => a.trim()).filter(Boolean) : null;
        const token = await createMcpLoginToken({ user_id, apps });
        return mcpLoginSuccessPage({ mcpUrl: `${config.BASE_URL}/mcp`, token, userId: user_id, reused });
      } catch (err) {
        // Same "a 500-shaped failure must never be silent" fix as every *_routes.ts JSON error path
        // (see src/lib/errors.ts's errorResponse) — this one renders an HTML page instead of JSON, so it
        // can't reuse that helper directly, but it still needs the same server-side log.
        console.error("[mcp] request failed:", err);
        return errorPage(formatError(err));
      }
    },
  },

  "/mcp": {
    GET: async (req: Request) => handleMcpHttpRequest(req),
    POST: async (req: Request) => handleMcpHttpRequest(req),
    DELETE: async (req: Request) => handleMcpHttpRequest(req),
  },

  // Hosted "your connections" status page (PHASES.md Phase 7 gap) — a persistent page a human can revisit
  // to see every connection's live status at a glance, connect an app that isn't yet, or disconnect one.
  // Public route (browser-visited, can't attach our Authorization header) — auth is the same long-lived
  // MCP login token every other /mcp/* page already relies on, not a new credential.
  "/mcp/connections": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const token = url.searchParams.get("token");
      if (!token) return mcpLoginFormPage({ errorMessage: "Log in first to view your connections." });
      const payload = await resolveMcpLoginToken(token);
      if (!payload) return mcpLoginFormPage({ errorMessage: "That link has expired or is invalid — log in again." });

      const { connections } = await listConnections(payload.user_id, {}, payload.apps);
      const apps = payload.apps ? listApps().filter((a) => payload.apps!.includes(a.id)) : listApps();
      const live = connections.filter((c) => c.status !== "revoked");
      const connectedAppIds = new Set(live.filter((c) => c.status === "active" || c.status === "pending").map((c) => c.app));

      return connectionsStatusPage({
        token,
        connections: live
          .map((c) => ({ connection_id: c.connection_id, appName: getApp(c.app).name, status: c.status, created_at: c.created_at }))
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
        connectableApps: apps.filter((a) => !connectedAppIds.has(a.id)).map((a) => ({ id: a.id, name: a.name })),
      });
    },
  },

  // Kicks off a connect flow straight from the status page instead of round-tripping through an MCP
  // client — same manage_connection get-or-create logic, just fronted by a GET link a browser can follow.
  "/mcp/connections/connect/:app": {
    GET: async (req: Request & { params: { app: string } }) => {
      const url = new URL(req.url);
      const token = url.searchParams.get("token");
      if (!token) return mcpLoginFormPage({ errorMessage: "Log in first to connect an app." });
      const payload = await resolveMcpLoginToken(token);
      if (!payload) return mcpLoginFormPage({ errorMessage: "That link has expired or is invalid — log in again." });

      try {
        const result = await manageConnection(payload.user_id, { app: req.params.app }, payload.apps);
        const destination =
          result.status === "pending" && result.connect_url ? result.connect_url : `${config.BASE_URL}/mcp/connections?token=${encodeURIComponent(token)}`;
        return Response.redirect(destination, 302);
      } catch (err) {
        // Same "a 500-shaped failure must never be silent" fix as every *_routes.ts JSON error path
        // (see src/lib/errors.ts's errorResponse) — this one renders an HTML page instead of JSON, so it
        // can't reuse that helper directly, but it still needs the same server-side log.
        console.error("[mcp] request failed:", err);
        return errorPage(formatError(err));
      }
    },
  },

  "/mcp/connections/:id/disconnect": {
    POST: async (req: Request & { params: { id: string } }) => {
      const form = await req.formData();
      const token = form.get("token");
      if (typeof token !== "string" || !token) return mcpLoginFormPage({ errorMessage: "Log in first to manage your connections." });
      const payload = await resolveMcpLoginToken(token);
      if (!payload) return mcpLoginFormPage({ errorMessage: "That link has expired or is invalid — log in again." });

      try {
        await disconnectConnection(payload.user_id, { connection_id: req.params.id }, payload.apps);
      } catch (err) {
        // Same "a 500-shaped failure must never be silent" fix as every *_routes.ts JSON error path
        // (see src/lib/errors.ts's errorResponse) — this one renders an HTML page instead of JSON, so it
        // can't reuse that helper directly, but it still needs the same server-side log.
        console.error("[mcp] request failed:", err);
        return errorPage(formatError(err));
      }
      return Response.redirect(`${config.BASE_URL}/mcp/connections?token=${encodeURIComponent(token)}`, 302);
    },
  },
};

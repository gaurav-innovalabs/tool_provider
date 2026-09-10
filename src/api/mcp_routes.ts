// Browser-facing "MCP login" (GET/POST /mcp/login) + the remote MCP protocol endpoint itself
// (GET/POST/DELETE /mcp). Grouped together like webhook_routes.ts groups oauth_callback + inbound
// webhooks — both are "the MCP front door", one half is a human filling a form, the other half is an
// MCP client speaking JSON-RPC, but they're one concern (Phase-MCP-2) split across two file-level route
// groups for readability, not two files.

import { z } from "zod";
import { userStore } from "../core/store";
import { createMcpLoginToken } from "../lib/mcpTokens";
import { config } from "../config";
import { mcpLoginFormPage, mcpLoginSuccessPage, errorPage } from "../lib/connectPage";
import { handleMcpHttpRequest } from "../mcp/httpServer";

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
        return errorPage(err instanceof Error ? err.message : String(err));
      }
    },
  },

  "/mcp": {
    GET: async (req: Request) => handleMcpHttpRequest(req),
    POST: async (req: Request) => handleMcpHttpRequest(req),
    DELETE: async (req: Request) => handleMcpHttpRequest(req),
  },
};

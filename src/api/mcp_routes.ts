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
        body = loginBody.parse({ access_key: form.get("access_key"), apps: form.get("apps") || undefined });
      } catch {
        return mcpLoginFormPage({ errorMessage: "Access key is required." });
      }

      if (!config.security.AuthKey || body.access_key !== config.security.AuthKey) {
        return mcpLoginFormPage({ errorMessage: "That access key isn't valid." });
      }

      try {
        // A fresh User per login, same as POST /users — no "log back in as an existing user_id" step
        // yet (would need its own credential, out of scope for this pass; see MCP_GUIDE.md TODOs).
        const user_id = `usr_${crypto.randomUUID()}`;
        await userStore.create({ user_id, user_metadata: { source: "mcp_login" }, created_at: new Date().toISOString() });
        const apps = body.apps?.trim() ? body.apps.split(",").map((a) => a.trim()).filter(Boolean) : null;
        const token = await createMcpLoginToken({ user_id, apps });
        return mcpLoginSuccessPage({ mcpUrl: `${config.BASE_URL}/mcp`, token });
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

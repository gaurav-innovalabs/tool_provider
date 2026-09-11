// MCP-spec OAuth 2.1 authorization server — the dynamic counterpart to /mcp/login (src/api/mcp_routes.ts).
// Un-gated on purpose (same reasoning as mcpRoutes in src/server.ts): a client hits these BEFORE it has
// any credential at all — that's the whole point. Auth here is the browser-facing access_key + user_id
// form (oauthAuthorizePage), not a bearer token on these routes themselves.
//
// Flow (RFC 7591 dynamic client registration + RFC 7636 PKCE authorization code grant, the subset the MCP
// authorization spec requires): client discovers these endpoints via GET /.well-known/oauth-authorization-
// server (advertised off a 401's WWW-Authenticate header — see src/mcp/httpServer.ts), POSTs
// /oauth/register once to get a client_id, opens /oauth/authorize in a browser (human fills in the same
// access_key/user_id fields /mcp/login already uses), gets redirected back with a code, POSTs
// /oauth/token to exchange it for the same long-lived bearer token src/lib/mcpTokens.ts mints for
// /mcp/login. From here on it's indistinguishable from a token pasted in manually — same /mcp endpoint,
// same session model.

import { z } from "zod";
import { userStore } from "../core/store";
import { createMcpLoginToken } from "../lib/mcpTokens";
import { registerClient, getClient, createAuthCode, consumeAuthCode, verifyPkce } from "../lib/oauthProvider";
import { config } from "../config";
import { oauthAuthorizePage, errorPage } from "../lib/connectPage";
import { formatError } from "../lib/errors";

function oauthError(status: number, error: string, description?: string) {
  return Response.json({ error, error_description: description }, { status });
}

const registerBody = z.object({
  redirect_uris: z.array(z.string().url()).min(1),
});

const authorizeQuery = z.object({
  response_type: z.literal("code"),
  client_id: z.string(),
  redirect_uri: z.string().url(),
  state: z.string().optional().default(""),
  code_challenge: z.string(),
  code_challenge_method: z.literal("S256"),
});

const authorizeForm = z.object({
  access_key: z.string(),
  user_id: z.string().optional(),
  client_id: z.string(),
  redirect_uri: z.string().url(),
  state: z.string().optional().default(""),
  code_challenge: z.string(),
  code_challenge_method: z.string(),
});

const tokenBody = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string(),
  redirect_uri: z.string().url(),
  client_id: z.string(),
  code_verifier: z.string(),
});

export const oauthRoutes = {
  // RFC 9728 protected resource metadata — this is what src/mcp/httpServer.ts's WWW-Authenticate header
  // on a 401 points to, so a spec-compliant client can find the authorization server without being told
  // its URL out of band.
  "/.well-known/oauth-protected-resource": {
    GET: async () =>
      Response.json({
        resource: `${config.BASE_URL}/mcp`,
        authorization_servers: [config.BASE_URL],
      }),
  },

  // RFC 8414 authorization server metadata.
  "/.well-known/oauth-authorization-server": {
    GET: async () =>
      Response.json({
        issuer: config.BASE_URL,
        authorization_endpoint: `${config.BASE_URL}/oauth/authorize`,
        token_endpoint: `${config.BASE_URL}/oauth/token`,
        registration_endpoint: `${config.BASE_URL}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      }),
  },

  // RFC 7591 dynamic client registration — no client_secret issued (public client, PKCE-only, matches
  // token_endpoint_auth_methods_supported above). A client registers once per install and reuses the
  // client_id it gets back.
  "/oauth/register": {
    POST: async (req: Request) => {
      try {
        const body = registerBody.parse(await req.json());
        const client = await registerClient(body.redirect_uris);
        return Response.json(
          {
            client_id: client.client_id,
            redirect_uris: client.redirect_uris,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
          },
          { status: 201 },
        );
      } catch (err) {
        return oauthError(400, "invalid_client_metadata", formatError(err));
      }
    },
  },

  "/oauth/authorize": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const parsed = authorizeQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return oauthError(400, "invalid_request", "Missing/invalid response_type, client_id, redirect_uri, code_challenge, or code_challenge_method (only S256 is supported).");
      const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = parsed.data;

      const client = await getClient(client_id);
      if (!client) return oauthError(400, "invalid_client", `Unknown client_id "${client_id}" — register via POST /oauth/register first.`);
      if (!client.redirect_uris.includes(redirect_uri)) return oauthError(400, "invalid_request", "redirect_uri does not match any URI registered for this client_id.");

      return oauthAuthorizePage({ client_id, redirect_uri, state, code_challenge, code_challenge_method });
    },

    POST: async (req: Request) => {
      let body: z.infer<typeof authorizeForm>;
      try {
        const form = await req.formData();
        body = authorizeForm.parse({
          access_key: form.get("access_key"),
          user_id: form.get("user_id") || undefined,
          client_id: form.get("client_id"),
          redirect_uri: form.get("redirect_uri"),
          state: form.get("state") || "",
          code_challenge: form.get("code_challenge"),
          code_challenge_method: form.get("code_challenge_method"),
        });
      } catch {
        return errorPage("Malformed authorization request.");
      }

      const client = await getClient(body.client_id);
      if (!client || !client.redirect_uris.includes(body.redirect_uri)) {
        return errorPage("Unknown client or redirect_uri — the MCP client may need to reconnect.");
      }

      // Same unified bearer tokens as everywhere else (src/lib/apiAuth.ts) — this form IS the auth check,
      // there's nothing else gating it.
      if (body.access_key !== config.security.ACCESS_TOKEN && body.access_key !== config.security.ADMIN_ACCESS_TOKEN) {
        return oauthAuthorizePage({
          errorMessage: "That access key isn't valid.",
          userId: body.user_id,
          client_id: body.client_id,
          redirect_uri: body.redirect_uri,
          state: body.state,
          code_challenge: body.code_challenge,
          code_challenge_method: body.code_challenge_method,
        });
      }

      try {
        const requestedUserId = body.user_id?.trim();
        let user_id: string;
        if (requestedUserId) {
          const existing = await userStore.get(requestedUserId);
          if (!existing) {
            return oauthAuthorizePage({
              errorMessage: `Unknown user ID "${requestedUserId}" — leave blank to create a new one.`,
              client_id: body.client_id,
              redirect_uri: body.redirect_uri,
              state: body.state,
              code_challenge: body.code_challenge,
              code_challenge_method: body.code_challenge_method,
            });
          }
          user_id = existing.user_id;
        } else {
          user_id = `usr_${crypto.randomUUID()}`;
          await userStore.create({ user_id, user_metadata: { source: "mcp_oauth" }, created_at: new Date().toISOString() });
        }

        const code = await createAuthCode({
          user_id,
          apps: null,
          client_id: body.client_id,
          redirect_uri: body.redirect_uri,
          code_challenge: body.code_challenge,
        });

        const redirect = new URL(body.redirect_uri);
        redirect.searchParams.set("code", code);
        if (body.state) redirect.searchParams.set("state", body.state);
        return Response.redirect(redirect.toString(), 302);
      } catch (err) {
        console.error("[oauth] authorize failed:", err);
        return errorPage(formatError(err));
      }
    },
  },

  "/oauth/token": {
    POST: async (req: Request) => {
      let body: z.infer<typeof tokenBody>;
      try {
        const contentType = req.headers.get("content-type") ?? "";
        const raw = contentType.includes("application/json") ? await req.json() : Object.fromEntries((await req.formData()).entries());
        body = tokenBody.parse(raw);
      } catch (err) {
        return oauthError(400, "invalid_request", formatError(err));
      }

      const pending = await consumeAuthCode(body.code);
      if (!pending) return oauthError(400, "invalid_grant", "Unknown, expired, or already-used authorization code.");
      if (pending.client_id !== body.client_id || pending.redirect_uri !== body.redirect_uri) {
        return oauthError(400, "invalid_grant", "client_id/redirect_uri do not match the ones used at /oauth/authorize.");
      }
      const pkceOk = await verifyPkce(body.code_verifier, pending.code_challenge);
      if (!pkceOk) return oauthError(400, "invalid_grant", "code_verifier does not match the code_challenge from /oauth/authorize.");

      const access_token = await createMcpLoginToken({ user_id: pending.user_id, apps: pending.apps });
      return Response.json({ access_token, token_type: "Bearer" });
    },
  },
};

// Generic OAuth2 helpers, shared by every oauth2-type App's auth config. We run the actual OAuth dance
// ourselves (unlike the Composio-brokered pattern in /home/gr/projects/backend — there, Composio holds the
// token and hands back only a connected_account_id; here, WE hold it, per Connection.secrets in types.ts).
// Standard authorization-code grant — works unmodified for both Google and Slack.
//
// Only ever called for auth.type === "oauth2" apps (Gmail, Slack) — api_key apps (SerpApi) never touch
// this file at all, see connection_routes.ts's branch on app.auth.type.

import type { AppAuthConfig, Secrets } from "../types";
import { config } from "../config";

type OAuth2AuthConfig = Extract<AppAuthConfig, { type: "oauth2" }>;

export function redirectUriFor(app: string): string {
  return `${config.BASE_URL}/oauth/callback/${app}`;
}

export function buildAuthorizeUrl(auth: OAuth2AuthConfig, app: string, state: string): string {
  const url = new URL(auth.authorize_url);
  url.searchParams.set("client_id", auth.client_id);
  url.searchParams.set("redirect_uri", redirectUriFor(app));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", auth.scopes.join(" "));
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(auth.extraAuthorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function exchangeCodeForToken(auth: OAuth2AuthConfig, app: string, code: string): Promise<Secrets> {
  const res = await fetch(auth.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: auth.client_id,
      client_secret: auth.client_secret,
      code,
      redirect_uri: redirectUriFor(app),
      grant_type: "authorization_code",
    }),
  });

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number; // seconds
    scope?: string;
    // Slack-specific: unlike a standard OAuth2 token endpoint, Slack's `oauth.v2.access` returns HTTP 200
    // even on failure — the real result is this `ok`/`error` pair in the body (same pattern as their Web
    // API, see components/slack/actions/postMessage.ts). `ok` is simply absent from Google's response, so
    // this check is a no-op there — safe to apply generically rather than branching per-provider.
    ok?: boolean;
    error?: string;
  };

  if (!res.ok || data.ok === false || !data.access_token) {
    throw new Error(`OAuth token exchange failed (${res.status}): ${data.error ?? JSON.stringify(data)}`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
    scope: data.scope,
  };
}

export async function refreshToken(_auth: OAuth2AuthConfig, _secrets: Secrets): Promise<Secrets> {
  // Phase 1: not called anywhere yet (no scheduler). Phase 4 wires this to the proactive
  // refresh-ahead-of-expiry pattern from research/auth-patterns.md #4 (Nango's refresh_exhausted state machine).
  throw new Error("not implemented");
}

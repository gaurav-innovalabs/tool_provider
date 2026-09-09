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
    // Also Slack-specific — which workspace this token belongs to. Captured so an inbound Slack Events
    // API POST (which carries team_id, not a connection_id) can be routed to the right Connection — see
    // src/api/webhook_routes.ts's /webhooks/slack/events handler. Absent from Google's response, so this
    // is undefined (and simply omitted from the returned Secrets) for Gmail connections.
    team?: { id: string };
  };

  if (!res.ok || data.ok === false || !data.access_token) {
    throw new Error(`OAuth token exchange failed (${res.status}): ${data.error ?? JSON.stringify(data)}`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
    scope: data.scope,
    team_id: data.team?.id,
  };
}

// Standard OAuth2 refresh_token grant — works unmodified for Google (always returns one on refresh) and
// Slack (only relevant if the Slack app has token rotation enabled; a non-rotating Slack app never sets
// `expires_at` in the first place, so src/core/tokenRefresh.ts's caller never calls this for it — see that
// file's header for why this function itself doesn't need to know which app it's refreshing).
export async function refreshToken(auth: OAuth2AuthConfig, secrets: Secrets): Promise<Secrets> {
  if (!secrets.refresh_token) {
    throw new Error("No refresh_token on this connection — the user needs to reconnect.");
  }

  const res = await fetch(auth.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: auth.client_id,
      client_secret: auth.client_secret,
      refresh_token: secrets.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string; // Slack's rotation flow returns a new one each time (single-use); Google omits this on refresh
    expires_in?: number;
    scope?: string;
    ok?: boolean; // Slack-only, same 200-with-ok-false quirk as exchangeCodeForToken above
    error?: string;
  };

  if (!res.ok || data.ok === false || !data.access_token) {
    throw new Error(`OAuth token refresh failed (${res.status}): ${data.error ?? JSON.stringify(data)}`);
  }

  return {
    ...secrets,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? secrets.refresh_token,
    expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : secrets.expires_at,
    scope: data.scope ?? secrets.scope,
  };
}

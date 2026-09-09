// Proactive refresh-ahead-of-expiry, per research/auth-patterns.md #4 (Nango's real pattern, verified
// during R&D) — refresh a few minutes BEFORE expiry, not reactively on a 401. Called once at the top of
// every real provider call site (src/api/action_routes.ts before action.run(), src/core/scheduler.ts
// before trigger.poll()) — webhook-mode delivery (Slack) never calls this, it doesn't make outbound
// provider calls at all.
//
// A no-op for connections whose secrets never carry `expires_at` (api_key apps, and any oauth2 connection
// whose provider didn't return an expiry — e.g. a non-rotating Slack app) — nothing to refresh, nothing to do.
//
// Deliberately simple compared to auth-patterns.md's full spec (no refresh_attempts/refresh_exhausted
// counters — that's more state than this project's scale needs right now): a refresh failure just marks
// the connection `error` and rethrows, same "no retry, just fail" decision already made for triggers
// (src/core/scheduler.ts) — the caller's own error path (action_routes.ts / scheduler.ts) already handles
// a rejected promise correctly.

import { refreshToken } from "../lib/oauth";
import { connectionStore } from "./store";
import type { AppDefinition, Connection } from "../types";

// Refresh this far ahead of the real expiry, not exactly at it — avoids a request racing an
// about-to-expire token. 5 minutes, per research/auth-patterns.md #4's "margin constant" recommendation.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function needsRefresh(connection: Connection): boolean {
  const expiresAt = connection.secrets?.expires_at;
  if (!expiresAt) {
    return false; // no expiry on record — api_key app, or an oauth2 provider that never set one
  }
  return new Date(expiresAt).getTime() - Date.now() <= REFRESH_MARGIN_MS;
}

// Returns the connection unchanged if no refresh was needed, or the freshly-refreshed one (already
// persisted to the store) if it was. Callers should use the returned connection, not their original one.
export async function ensureFreshConnection(app: AppDefinition, connection: Connection): Promise<Connection> {
  if (app.auth.type !== "oauth2" || !connection.secrets || !needsRefresh(connection)) {
    return connection;
  }

  try {
    const refreshed = await refreshToken(app.auth, connection.secrets);
    const updated_at = new Date().toISOString();
    await connectionStore.update(connection.connection_id, { secrets: refreshed, updated_at });
    return { ...connection, secrets: refreshed, updated_at };
  } catch (err) {
    // Matches exchangeCodeForToken's failure handling in webhook_routes.ts's oauth callback — a broken
    // credential is surfaced as connection status "error", not silently retried.
    await connectionStore.update(connection.connection_id, { status: "error", updated_at: new Date().toISOString() });
    throw err;
  }
}

// Sweeps connections stuck in "pending" past their deadline (Connection.expires_at, set at connect-token
// creation time — src/api/connection_routes.ts) to "expired". Handles the case where an end user opens a
// connect_url but never finishes (closes the tab, abandons the OAuth consent screen) — per
// src/mcp/metaTools.ts's getOrCreateActiveConnection, an orphaned pending row is never reused, so left
// alone it would just sit there forever.
//
// Single-process setInterval, same reasoning as src/core/scheduler.ts's poll cycle: only one worker
// process runs at a time, and the underlying UPDATE ... WHERE is a single atomic statement anyway, so
// there's nothing to lock even if it weren't.

import { connectionStore } from "./store";

// How long an end user has to finish an oauth2/api_key connect flow before it's abandoned.
export const PENDING_CONNECTION_TTL_MS = 15 * 60 * 1000;

// How often this process checks for stale pending connections — matches the scheduler's own tick
// granularity (src/core/scheduler.ts), not a per-connection cadence.
const SWEEP_TICK_MS = 2 * 60 * 1000;

export async function expireStaleConnections(): Promise<void> {
  const expired = await connectionStore.expireStalePending();
  if (expired.length > 0) {
    console.log(`[connectionExpiry] expired ${expired.length} stale pending connection(s): ${expired.join(", ")}`);
  }
}

export function startConnectionExpirySweep(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    expireStaleConnections().catch((err) => console.error("[connectionExpiry] sweep threw:", err));
  }, SWEEP_TICK_MS);
}

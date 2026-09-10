// Verifies Slack's request signature on inbound Events API POSTs (src/api/webhook_routes.ts's
// /webhooks/slack/events). Same algorithm n8n's SlackTrigger.node.ts actually implements (verified from
// their real source during R&D): HMAC-SHA256 of `v0:{timestamp}:{rawBody}` using the app's signing
// secret, compared against the `X-Slack-Signature` header. Must use the RAW body string — parsing to JSON
// and re-stringifying would silently break this (whitespace/key-order differences change the signature).
//
// https://api.slack.com/authentication/verifying-requests-from-slack

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";

const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5; // Slack's own recommendation — reject anything older, replay defense

// Every `return false` below used to be silent — the caller (events.ts) only knew "invalid", never WHY,
// so a real misconfiguration (stale secret, clock skew) looked identical in the logs to Slack simply never
// having called us. Logging the specific reason here (never the secret or signature value itself) turns a
// silent, undebuggable 401 into something you can actually diagnose from `bun run dev`'s own output.
export function verifySlackSignature(rawBody: string, timestampHeader: string | null, signatureHeader: string | null): boolean {
  if (!config.apps.slack.SLACK_SIGNING_SECRET) {
    throw new Error("SLACK_SIGNING_SECRET is not set — cannot verify inbound Slack requests.");
  }
  if (!timestampHeader || !signatureHeader) {
    console.warn(`[webhooks] Slack signature check failed: missing ${!timestampHeader ? "x-slack-request-timestamp" : "x-slack-signature"} header — not a real Slack request, or a proxy stripped it.`);
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    console.warn(`[webhooks] Slack signature check failed: x-slack-request-timestamp "${timestampHeader}" isn't a number.`);
    return false;
  }
  const skew = Date.now() / 1000 - timestamp;
  if (Math.abs(skew) > MAX_TIMESTAMP_SKEW_SECONDS) {
    console.warn(
      `[webhooks] Slack signature check failed: timestamp is ${Math.round(skew)}s off from server time (max ${MAX_TIMESTAMP_SKEW_SECONDS}s) — check this machine's clock is correct, this isn't a replay unless skew is small and unexplained.`,
    );
    return false;
  }

  const base = `v0:${timestampHeader}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", config.apps.slack.SLACK_SIGNING_SECRET).update(base).digest("hex")}`;

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  // timingSafeEqual throws if lengths differ — that's a genuine mismatch, not a bug, so treat it as "not valid".
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    console.warn(
      "[webhooks] Slack signature check failed: computed signature doesn't match x-slack-signature — SLACK_SIGNING_SECRET in .env likely doesn't match this app's real Signing Secret (Basic Information -> App Credentials), or the raw body was altered in transit.",
    );
    return false;
  }
  return true;
}

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

export function verifySlackSignature(rawBody: string, timestampHeader: string | null, signatureHeader: string | null): boolean {
  if (!config.apps.slack.SLACK_SIGNING_SECRET) {
    throw new Error("SLACK_SIGNING_SECRET is not set — cannot verify inbound Slack requests.");
  }
  if (!timestampHeader || !signatureHeader) {
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return false;
  }

  const base = `v0:${timestampHeader}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", config.apps.slack.SLACK_SIGNING_SECRET).update(base).digest("hex")}`;

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  // timingSafeEqual throws if lengths differ — that's a genuine mismatch, not a bug, so treat it as "not valid".
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

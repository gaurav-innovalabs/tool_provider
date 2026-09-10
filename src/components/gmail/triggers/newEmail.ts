// Poll via history.list + historyId cursor (Pipedream's pattern, per docs/research/gmail-deep-dive.md), NOT
// messages.list + timestamp (n8n/Activepieces' pattern, which needed 4 extra tuning constants to be
// correct at the edges). No SDK — plain fetch, same as every action.
//
// Pub/Sub watch() push mode is explicitly OUT of scope (needs its own GCP topic + IAM + 7-day renewal
// scheduler, per gmail-deep-dive.md recommendation #1) — this is the polling-only path.

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";
import { config } from "../../../config";

export interface GmailHistoryCursor {
  historyId: string;
}

export interface NewEmailEvent {
  message_id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  // The message's own date (Gmail's `internalDate`, epoch millis converted to ISO) — NOT when this event
  // was delivered to your webhook_url (that's the envelope's own top-level `timestamp`, a separate,
  // always-later value). Same field/conversion as get_email's `received_at`.
  received_at: string;
}

const newEmailPayload: z.ZodType<NewEmailEvent> = z.object({
  message_id: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  snippet: z.string(),
  received_at: z.string(),
});

interface GmailProfileResponse {
  historyId: string;
}

interface GmailHistoryListResponse {
  history?: { messagesAdded?: { message: { id: string } }[] }[];
  historyId: string;
  error?: { code: number; message: string };
}

interface GmailMessageGetResponse {
  id: string;
  snippet: string;
  internalDate: string; // epoch millis, as a string — present regardless of `format`, same as get_email's
  payload: { headers: { name: string; value: string }[] };
}

function header(msg: GmailMessageGetResponse, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

async function seedCursor(authHeaders: Record<string, string>): Promise<GmailHistoryCursor> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: authHeaders });
  if (!res.ok) {
    throw new Error(`Gmail new_email trigger: failed to seed historyId (${res.status}): ${await describeGoogleApiError(res)}`);
  }
  const profile = (await res.json()) as GmailProfileResponse;
  return { historyId: profile.historyId };
}

export const newEmail: TriggerDefinition<GmailHistoryCursor, NewEmailEvent> = {
  key: "new_email",
  description: "Fires when a new email arrives in the connected Gmail account.",
  mode: "poll",
  // 8 min, per spec. (For reference: Pipedream's real DEFAULT_POLLING_SOURCE_TIMER_INTERVAL is 15 min,
  // Composio's minimum is also 15 min — both verified from real source/docs during R&D. 8 min here is a
  // deliberate choice, not derived from either.) Overridable per-subscription (src/api/trigger_routes.ts),
  // not a fixed global setting — see src/core/scheduler.ts's header for why there's no global interval.
  defaultPollIntervalMs: config.apps.gmail.GMAIL_POLL_INTERVAL_MS, // env-configurable, default 8 min — see config.ts's comment
  payload: newEmailPayload,
  async poll(connection, cursor) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const authHeaders = { Authorization: `Bearer ${connection.secrets.access_token}` };

    if (!cursor) {
      // First poll ever for this trigger instance — seed the cursor, don't backfill existing mail as
      // "new" events.
      return { events: [], nextCursor: await seedCursor(authHeaders) };
    }

    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
    url.searchParams.set("startHistoryId", cursor.historyId);
    url.searchParams.append("historyTypes", "messageAdded");

    const res = await fetch(url, { headers: authHeaders });
    const data = (await res.json()) as GmailHistoryListResponse;

    if (!res.ok) {
      if (res.status === 404) {
        // historyId fell out of Gmail's retention window — per gmail-deep-dive.md, reseed rather than error.
        return { events: [], nextCursor: await seedCursor(authHeaders) };
      }
      throw new Error(`Gmail new_email trigger failed (${res.status}): ${data.error?.message ?? res.statusText}`);
    }

    const messageIds = (data.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message.id));
    // Dedup — the same message can appear in more than one history record within one page.
    const uniqueIds = [...new Set(messageIds)];

    // A single message's fetch failing here must NOT throw and abort the whole poll() call — if it did,
    // nextCursor below would never be returned, the cursor would stay stuck at this exact historyId
    // forever, and EVERY future poll would re-fetch the same history range, hit the same missing message,
    // and fail again — permanently breaking this trigger for one bad message (e.g. one that was deleted in
    // the gap between history.list listing it and this messages.get call, a real, not-hypothetical race).
    // Skip and log instead; every other message in this batch still gets delivered, the cursor still
    // advances, and the trigger keeps working.
    const events = (
      await Promise.all(
        uniqueIds.map(async (id): Promise<NewEmailEvent | null> => {
          const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
          msgUrl.searchParams.set("format", "metadata");
          msgUrl.searchParams.append("metadataHeaders", "From");
          msgUrl.searchParams.append("metadataHeaders", "To");
          msgUrl.searchParams.append("metadataHeaders", "Subject");
          const msgRes = await fetch(msgUrl, { headers: authHeaders });
          if (!msgRes.ok) {
            console.warn(`[gmail new_email] skipping message ${id}: fetch failed (${msgRes.status}): ${await describeGoogleApiError(msgRes)}`);
            return null;
          }
          const msg = (await msgRes.json()) as GmailMessageGetResponse;
          return {
            message_id: msg.id,
            from: header(msg, "From"),
            to: header(msg, "To"),
            subject: header(msg, "Subject"),
            snippet: msg.snippet,
            received_at: new Date(Number(msg.internalDate)).toISOString(),
          };
        }),
      )
    ).filter((event): event is NewEmailEvent => event !== null);

    return { events, nextCursor: { historyId: data.historyId } };
  },
};

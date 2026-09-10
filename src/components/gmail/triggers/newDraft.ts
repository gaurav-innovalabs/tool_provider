// Real trigger, same shape as new_email — creating a draft adds a message carrying the DRAFT system
// label, so this watches the same historyTypes: messageAdded feed as new_email and filters for DRAFT
// (same technique new_sent_email uses for SENT). Gmail's history API has no dedicated "draftAdded" type.

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";
import { config } from "../../../config";

export interface GmailHistoryCursor {
  historyId: string;
}

export interface NewDraftEvent {
  message_id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  // `updated_at`, not `received_at` — Gmail's `internalDate` for a draft is its LAST SAVE time, and a
  // draft gets resaved repeatedly (every edit), so "received" would be misleading. Same conversion
  // (internalDate epoch millis -> ISO) as get_email's `received_at` and new_email.ts's own event, just a
  // more accurate field name for what a draft's own date actually represents.
  updated_at: string;
}

const newDraftPayload: z.ZodType<NewDraftEvent> = z.object({
  message_id: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  snippet: z.string(),
  updated_at: z.string(),
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
  labelIds?: string[];
  snippet: string;
  internalDate: string; // epoch millis, as a string — present regardless of `format`
  payload: { headers: { name: string; value: string }[] };
}

function header(msg: GmailMessageGetResponse, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

async function seedCursor(authHeaders: Record<string, string>): Promise<GmailHistoryCursor> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: authHeaders });
  if (!res.ok) {
    throw new Error(`Gmail new_draft trigger: failed to seed historyId (${res.status}): ${await describeGoogleApiError(res)}`);
  }
  const profile = (await res.json()) as GmailProfileResponse;
  return { historyId: profile.historyId };
}

export const newDraft: TriggerDefinition<GmailHistoryCursor, NewDraftEvent> = {
  key: "new_draft",
  description: "Fires when a new draft is created in the connected Gmail account.",
  mode: "poll",
  defaultPollIntervalMs: config.apps.gmail.GMAIL_POLL_INTERVAL_MS, // env-configurable, default 8 min — see config.ts's comment
  payload: newDraftPayload,
  async poll(connection, cursor) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const authHeaders = { Authorization: `Bearer ${connection.secrets.access_token}` };

    if (!cursor) {
      return { events: [], nextCursor: await seedCursor(authHeaders) };
    }

    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
    url.searchParams.set("startHistoryId", cursor.historyId);
    url.searchParams.append("historyTypes", "messageAdded");

    const res = await fetch(url, { headers: authHeaders });
    const data = (await res.json()) as GmailHistoryListResponse;

    if (!res.ok) {
      if (res.status === 404) {
        return { events: [], nextCursor: await seedCursor(authHeaders) };
      }
      throw new Error(`Gmail new_draft trigger failed (${res.status}): ${data.error?.message ?? res.statusText}`);
    }

    const messageIds = (data.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message.id));
    const uniqueIds = [...new Set(messageIds)];

    // A single message's fetch failing here must NOT throw and abort the whole poll() call — see
    // newEmail.ts's fuller comment on the same pattern: it would leave nextCursor unreturned, permanently
    // stuck re-fetching the same failing message on every future poll. Skip and log instead.
    const messages = (
      await Promise.all(
        uniqueIds.map(async (id): Promise<GmailMessageGetResponse | null> => {
          const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
          msgUrl.searchParams.set("format", "metadata");
          msgUrl.searchParams.append("metadataHeaders", "From");
          msgUrl.searchParams.append("metadataHeaders", "To");
          msgUrl.searchParams.append("metadataHeaders", "Subject");
          const msgRes = await fetch(msgUrl, { headers: authHeaders });
          if (!msgRes.ok) {
            console.warn(`[gmail new_draft] skipping message ${id}: fetch failed (${msgRes.status}): ${await describeGoogleApiError(msgRes)}`);
            return null;
          }
          return (await msgRes.json()) as GmailMessageGetResponse;
        }),
      )
    ).filter((msg): msg is GmailMessageGetResponse => msg !== null);

    const events = messages
      .filter((msg) => (msg.labelIds ?? []).includes("DRAFT"))
      .map(
        (msg): NewDraftEvent => ({
          message_id: msg.id,
          from: header(msg, "From"),
          to: header(msg, "To"),
          subject: header(msg, "Subject"),
          snippet: msg.snippet,
          updated_at: new Date(Number(msg.internalDate)).toISOString(),
        }),
      );

    return { events, nextCursor: { historyId: data.historyId } };
  },
};

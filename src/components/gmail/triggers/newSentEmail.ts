// Real trigger, same shape as Pipedream's Gmail sources — fires when a message is sent from the connected
// account. Gmail's history API has no dedicated "messageSent" historyType, so this watches messageAdded
// (same as new_email) and filters for messages carrying the SENT system label — sending a message always
// adds it. Same history.list + historyId cursor mechanism as new_email.

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";
import { config } from "../../../config";

export interface GmailHistoryCursor {
  historyId: string;
}

export interface NewSentEmailEvent {
  message_id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  // The message's own send time (Gmail's `internalDate`), not the envelope's own delivery `timestamp` —
  // named `sent_at`, not `received_at`, since this trigger is specifically about OUTBOUND mail.
  sent_at: string;
}

const newSentEmailPayload: z.ZodType<NewSentEmailEvent> = z.object({
  message_id: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  snippet: z.string(),
  sent_at: z.string(),
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
    throw new Error(`Gmail new_sent_email trigger: failed to seed historyId (${res.status}): ${await describeGoogleApiError(res)}`);
  }
  const profile = (await res.json()) as GmailProfileResponse;
  return { historyId: profile.historyId };
}

export const newSentEmail: TriggerDefinition<GmailHistoryCursor, NewSentEmailEvent> = {
  key: "new_sent_email",
  description: "Fires when an email is sent from the connected Gmail account.",
  mode: "poll",
  defaultPollIntervalMs: config.apps.gmail.GMAIL_POLL_INTERVAL_MS, // env-configurable, default 8 min — see config.ts's comment
  payload: newSentEmailPayload,
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
      throw new Error(`Gmail new_sent_email trigger failed (${res.status}): ${data.error?.message ?? res.statusText}`);
    }

    const messageIds = (data.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message.id));
    const uniqueIds = [...new Set(messageIds)];

    // A single message's fetch failing here must NOT throw and abort the whole poll() call — see
    // newEmailReceived.ts's fuller comment on the same pattern: it would leave nextCursor unreturned, permanently
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
            console.warn(`[gmail new_sent_email] skipping message ${id}: fetch failed (${msgRes.status}): ${await describeGoogleApiError(msgRes)}`);
            return null;
          }
          return (await msgRes.json()) as GmailMessageGetResponse;
        }),
      )
    ).filter((msg): msg is GmailMessageGetResponse => msg !== null);

    const events = messages
      .filter((msg) => (msg.labelIds ?? []).includes("SENT"))
      .map(
        (msg): NewSentEmailEvent => ({
          message_id: msg.id,
          from: header(msg, "From"),
          to: header(msg, "To"),
          subject: header(msg, "Subject"),
          snippet: msg.snippet,
          sent_at: new Date(Number(msg.internalDate)).toISOString(),
        }),
      );

    return { events, nextCursor: { historyId: data.historyId } };
  },
};

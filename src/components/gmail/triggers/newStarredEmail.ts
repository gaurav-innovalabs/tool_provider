// Real trigger — starring a message is just Gmail applying the STARRED
// system label, so this watches the same historyTypes: labelAdded feed and filters for STARRED. No
// separate API concept for "starred" beyond that label.

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";
import { config } from "../../../config";

export interface GmailHistoryCursor {
  historyId: string;
}

export interface NewStarredEmailEvent {
  // Previously ONLY message_id, and no `payload` schema declared at all — a caller had no way to tell
  // WHAT email got starred without an extra get_email call per event, and GET /triggers showed
  // config/payload as null for this trigger entirely. Enriched to match the other Gmail triggers' own
  // shape: from/to/subject/snippet, plus the message's own date (Gmail's `internalDate`, NOT the
  // envelope's own delivery `timestamp`).
  message_id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  received_at: string;
}

const newStarredEmailPayload: z.ZodType<NewStarredEmailEvent> = z.object({
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
  history?: { labelsAdded?: { message: { id: string }; labelIds: string[] }[] }[];
  historyId: string;
  error?: { code: number; message: string };
}

interface GmailMessageGetResponse {
  id: string;
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
    throw new Error(`Gmail new_starred_email trigger: failed to seed historyId (${res.status}): ${await describeGoogleApiError(res)}`);
  }
  const profile = (await res.json()) as GmailProfileResponse;
  return { historyId: profile.historyId };
}

export const newStarredEmail: TriggerDefinition<GmailHistoryCursor, NewStarredEmailEvent> = {
  key: "new_starred_email",
  description: "Fires when an email is starred in the connected Gmail account.",
  mode: "poll",
  defaultPollIntervalMs: config.apps.gmail.GMAIL_POLL_INTERVAL_MS, // env-configurable, default 8 min — see config.ts's comment
  payload: newStarredEmailPayload,
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
    url.searchParams.append("historyTypes", "labelAdded");

    const res = await fetch(url, { headers: authHeaders });
    const data = (await res.json()) as GmailHistoryListResponse;

    if (!res.ok) {
      if (res.status === 404) {
        return { events: [], nextCursor: await seedCursor(authHeaders) };
      }
      throw new Error(`Gmail new_starred_email trigger failed (${res.status}): ${data.error?.message ?? res.statusText}`);
    }

    const starredIds = [
      ...new Set(
        (data.history ?? [])
          .flatMap((h) => h.labelsAdded ?? [])
          .filter((entry) => entry.labelIds.includes("STARRED"))
          .map((entry) => entry.message.id),
      ),
    ];

    // A single message's fetch failing here must NOT throw and abort the whole poll() call — see
    // newEmailReceived.ts's fuller comment on the same pattern: it would leave nextCursor unreturned, permanently
    // stuck re-fetching the same failing message on every future poll. Skip and log instead.
    const events = (
      await Promise.all(
        starredIds.map(async (id): Promise<NewStarredEmailEvent | null> => {
          const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
          msgUrl.searchParams.set("format", "metadata");
          msgUrl.searchParams.append("metadataHeaders", "From");
          msgUrl.searchParams.append("metadataHeaders", "To");
          msgUrl.searchParams.append("metadataHeaders", "Subject");
          const msgRes = await fetch(msgUrl, { headers: authHeaders });
          if (!msgRes.ok) {
            console.warn(`[gmail new_starred_email] skipping message ${id}: fetch failed (${msgRes.status}): ${await describeGoogleApiError(msgRes)}`);
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
    ).filter((event): event is NewStarredEmailEvent => event !== null);

    return { events, nextCursor: { historyId: data.historyId } };
  },
};

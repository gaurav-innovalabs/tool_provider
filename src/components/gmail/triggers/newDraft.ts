// Real trigger, same shape as new_email — creating a draft adds a message carrying the DRAFT system
// label, so this watches the same historyTypes: messageAdded feed as new_email and filters for DRAFT
// (same technique new_sent_email uses for SENT). Gmail's history API has no dedicated "draftAdded" type.

import type { TriggerDefinition } from "../../../types";

export interface GmailHistoryCursor {
  historyId: string;
}

export interface NewDraftEvent {
  message_id: string;
  to: string;
  subject: string;
  snippet: string;
}

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
  payload: { headers: { name: string; value: string }[] };
}

function header(msg: GmailMessageGetResponse, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

async function seedCursor(authHeaders: Record<string, string>): Promise<GmailHistoryCursor> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: authHeaders });
  if (!res.ok) {
    throw new Error(`Gmail new_draft trigger: failed to seed historyId (${res.status}): ${await res.text()}`);
  }
  const profile = (await res.json()) as GmailProfileResponse;
  return { historyId: profile.historyId };
}

export const newDraft: TriggerDefinition<GmailHistoryCursor, NewDraftEvent> = {
  key: "new_draft",
  description: "Fires when a new draft is created in the connected Gmail account.",
  mode: "poll",
  defaultPollIntervalMs: 8 * 60 * 1000, // 8 min, per spec — matches new_email/new_labeled_email
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

    const messages = await Promise.all(
      uniqueIds.map(async (id): Promise<GmailMessageGetResponse> => {
        const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
        msgUrl.searchParams.set("format", "metadata");
        msgUrl.searchParams.append("metadataHeaders", "To");
        msgUrl.searchParams.append("metadataHeaders", "Subject");
        const msgRes = await fetch(msgUrl, { headers: authHeaders });
        if (!msgRes.ok) {
          throw new Error(`Gmail new_draft trigger: message fetch failed for ${id} (${msgRes.status}): ${await msgRes.text()}`);
        }
        return (await msgRes.json()) as GmailMessageGetResponse;
      }),
    );

    const events = messages
      .filter((msg) => (msg.labelIds ?? []).includes("DRAFT"))
      .map((msg): NewDraftEvent => ({ message_id: msg.id, to: header(msg, "To"), subject: header(msg, "Subject"), snippet: msg.snippet }));

    return { events, nextCursor: { historyId: data.historyId } };
  },
};

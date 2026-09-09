// Poll via history.list + historyId cursor (Pipedream's pattern, per research/gmail-deep-dive.md), NOT
// messages.list + timestamp (n8n/Activepieces' pattern, which needed 4 extra tuning constants to be
// correct at the edges). No SDK — plain fetch, same as every action.
//
// Pub/Sub watch() push mode is explicitly OUT of scope (needs its own GCP topic + IAM + 7-day renewal
// scheduler, per gmail-deep-dive.md recommendation #1) — this is the polling-only path.

import type { TriggerDefinition } from "../../../types";

export interface GmailHistoryCursor {
  historyId: string;
}

export interface NewEmailEvent {
  message_id: string;
  from: string;
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
  snippet: string;
  payload: { headers: { name: string; value: string }[] };
}

function header(msg: GmailMessageGetResponse, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

async function seedCursor(authHeaders: Record<string, string>): Promise<GmailHistoryCursor> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: authHeaders });
  if (!res.ok) {
    throw new Error(`Gmail new_email trigger: failed to seed historyId (${res.status}): ${await res.text()}`);
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
  defaultPollIntervalMs: 8 * 60 * 1000,
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

    const events = await Promise.all(
      uniqueIds.map(async (id): Promise<NewEmailEvent> => {
        const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
        msgUrl.searchParams.set("format", "metadata");
        msgUrl.searchParams.append("metadataHeaders", "From");
        msgUrl.searchParams.append("metadataHeaders", "Subject");
        const msgRes = await fetch(msgUrl, { headers: authHeaders });
        if (!msgRes.ok) {
          throw new Error(`Gmail new_email trigger: message fetch failed for ${id} (${msgRes.status}): ${await msgRes.text()}`);
        }
        const msg = (await msgRes.json()) as GmailMessageGetResponse;
        return { message_id: msg.id, from: header(msg, "From"), subject: header(msg, "Subject"), snippet: msg.snippet };
      }),
    );

    return { events, nextCursor: { historyId: data.historyId } };
  },
};

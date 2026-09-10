// Real trigger, same shape as new_labeled_email — starring a message is just Gmail applying the STARRED
// system label, so this watches the same historyTypes: labelAdded feed and filters for STARRED. No
// separate API concept for "starred" beyond that label.

import type { TriggerDefinition } from "../../../types";

export interface GmailHistoryCursor {
  historyId: string;
}

export interface NewStarredEmailEvent {
  message_id: string;
}

interface GmailProfileResponse {
  historyId: string;
}

interface GmailHistoryListResponse {
  history?: { labelsAdded?: { message: { id: string }; labelIds: string[] }[] }[];
  historyId: string;
  error?: { code: number; message: string };
}

async function seedCursor(authHeaders: Record<string, string>): Promise<GmailHistoryCursor> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: authHeaders });
  if (!res.ok) {
    throw new Error(`Gmail new_starred_email trigger: failed to seed historyId (${res.status}): ${await res.text()}`);
  }
  const profile = (await res.json()) as GmailProfileResponse;
  return { historyId: profile.historyId };
}

export const newStarredEmail: TriggerDefinition<GmailHistoryCursor, NewStarredEmailEvent> = {
  key: "new_starred_email",
  description: "Fires when an email is starred in the connected Gmail account.",
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
    url.searchParams.append("historyTypes", "labelAdded");

    const res = await fetch(url, { headers: authHeaders });
    const data = (await res.json()) as GmailHistoryListResponse;

    if (!res.ok) {
      if (res.status === 404) {
        return { events: [], nextCursor: await seedCursor(authHeaders) };
      }
      throw new Error(`Gmail new_starred_email trigger failed (${res.status}): ${data.error?.message ?? res.statusText}`);
    }

    const events = (data.history ?? []).flatMap((h) =>
      (h.labelsAdded ?? [])
        .filter((entry) => entry.labelIds.includes("STARRED"))
        .map((entry): NewStarredEmailEvent => ({ message_id: entry.message.id })),
    );

    return { events, nextCursor: { historyId: data.historyId } };
  },
};

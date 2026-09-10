// Real trigger, verified against Pipedream's actual source (components/gmail/sources/new-labeled-email/
// new-labeled-email.mjs) — fires when a LABEL IS APPLIED TO A MESSAGE (not when a new label object is
// created — Gmail has no event for that at all, confirmed during R&D; there is no new_label trigger here
// for that reason). Same history.list + historyId cursor mechanism as new_email, just historyTypes:
// labelAdded instead of messageAdded.
//
// Pipedream lets you pick which specific label(s) to watch (a `labels` prop at deploy time). Simplified
// for now, per spec ("just like they did for now") — watches labelAdded for ALL labels, no per-instance
// label filter yet. Add one later if it's actually needed (same shape as Pipedream's `labels` prop would
// require threading a per-TriggerInstance config value through subscribe, which nothing else here does yet).

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";

export interface GmailHistoryCursor {
  historyId: string;
}

export interface NewLabeledEmailEvent {
  message_id: string;
  label_ids_added: string[];
}

const newLabeledEmailPayload: z.ZodType<NewLabeledEmailEvent> = z.object({
  message_id: z.string(),
  label_ids_added: z.array(z.string()),
});

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
    throw new Error(`Gmail new_labeled_email trigger: failed to seed historyId (${res.status}): ${await res.text()}`);
  }
  const profile = (await res.json()) as GmailProfileResponse;
  return { historyId: profile.historyId };
}

export const newLabeledEmail: TriggerDefinition<GmailHistoryCursor, NewLabeledEmailEvent> = {
  key: "new_labeled_email",
  description: "Fires when a label is applied to an email in the connected Gmail account.",
  mode: "poll",
  defaultPollIntervalMs: 8 * 60 * 1000, // 8 min, per spec
  payload: newLabeledEmailPayload,
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
      throw new Error(`Gmail new_labeled_email trigger failed (${res.status}): ${data.error?.message ?? res.statusText}`);
    }

    const events = (data.history ?? []).flatMap((h) =>
      (h.labelsAdded ?? []).map((entry) => ({ message_id: entry.message.id, label_ids_added: entry.labelIds })),
    );

    return { events, nextCursor: { historyId: data.historyId } };
  },
};

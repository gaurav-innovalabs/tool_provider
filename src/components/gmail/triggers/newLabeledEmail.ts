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
import { describeGoogleApiError } from "../../../lib/googleErrors";
import { config } from "../../../config";

export interface GmailHistoryCursor {
  historyId: string;
}

export interface NewLabeledEmailEvent {
  message_id: string;
  label_ids_added: string[];
  // Previously ONLY message_id + label_ids_added — a caller had no way to tell WHAT email got labeled
  // without an extra get_email call per event. Enriched to match new_email/new_draft/new_sent_email's own
  // shape: from/to/subject/snippet, plus the message's own date (Gmail's `internalDate`, NOT the
  // envelope's own delivery `timestamp`).
  from: string;
  to: string;
  subject: string;
  snippet: string;
  received_at: string;
}

const newLabeledEmailPayload: z.ZodType<NewLabeledEmailEvent> = z.object({
  message_id: z.string(),
  label_ids_added: z.array(z.string()),
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
    throw new Error(`Gmail new_labeled_email trigger: failed to seed historyId (${res.status}): ${await describeGoogleApiError(res)}`);
  }
  const profile = (await res.json()) as GmailProfileResponse;
  return { historyId: profile.historyId };
}

export const newLabeledEmail: TriggerDefinition<GmailHistoryCursor, NewLabeledEmailEvent> = {
  key: "new_labeled_email",
  description: "Fires when a label is applied to an email in the connected Gmail account.",
  mode: "poll",
  defaultPollIntervalMs: config.apps.gmail.GMAIL_POLL_INTERVAL_MS, // env-configurable, default 8 min — see config.ts's comment
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

    const labelEntries = (data.history ?? []).flatMap((h) => h.labelsAdded ?? []);
    // Fetch each unique message's metadata ONCE (not once per labelsAdded entry — the same message can
    // appear more than once in one history page, e.g. two separate label-add actions), then reuse it for
    // every entry pointing at that message.
    const uniqueIds = [...new Set(labelEntries.map((entry) => entry.message.id))];

    // A single message's fetch failing here must NOT throw and abort the whole poll() call — see
    // newEmail.ts's fuller comment on the same pattern: it would leave nextCursor unreturned, permanently
    // stuck re-fetching the same failing message on every future poll. Skip and log instead.
    const messageById = new Map<string, GmailMessageGetResponse>();
    await Promise.all(
      uniqueIds.map(async (id) => {
        const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
        msgUrl.searchParams.set("format", "metadata");
        msgUrl.searchParams.append("metadataHeaders", "From");
        msgUrl.searchParams.append("metadataHeaders", "To");
        msgUrl.searchParams.append("metadataHeaders", "Subject");
        const msgRes = await fetch(msgUrl, { headers: authHeaders });
        if (!msgRes.ok) {
          console.warn(`[gmail new_labeled_email] skipping message ${id}: fetch failed (${msgRes.status}): ${await describeGoogleApiError(msgRes)}`);
          return;
        }
        messageById.set(id, (await msgRes.json()) as GmailMessageGetResponse);
      }),
    );

    const events = labelEntries
      .map((entry): NewLabeledEmailEvent | null => {
        const msg = messageById.get(entry.message.id);
        if (!msg) return null; // that message's fetch failed above — already logged, just skip this event
        return {
          message_id: msg.id,
          label_ids_added: entry.labelIds,
          from: header(msg, "From"),
          to: header(msg, "To"),
          subject: header(msg, "Subject"),
          snippet: msg.snippet,
          received_at: new Date(Number(msg.internalDate)).toISOString(),
        };
      })
      .filter((event): event is NewLabeledEmailEvent => event !== null);

    return { events, nextCursor: { historyId: data.historyId } };
  },
};

// Poll via history.list + historyId cursor (Pipedream's pattern, per docs/research/gmail-deep-dive.md), NOT
// messages.list + timestamp (n8n/Activepieces' pattern, which needed 4 extra tuning constants to be
// correct at the edges). No SDK — plain fetch, same as every action.
//
// Pub/Sub watch() push mode is explicitly OUT of scope (needs its own GCP topic + IAM + 7-day renewal
// scheduler, per gmail-deep-dive.md recommendation #1) — this is the polling-only path.
//
// Renamed from new_email -> new_email_received (file newEmail.ts -> newEmailReceived.ts) to match
// Pipedream's own real source name exactly (gmail-new-email-received) — verified by listing
// PipedreamHQ/pipedream's actual components/gmail/sources/ directory, which also has a SEPARATE
// gmail-new-email-matching-search source (see newEmailMatchingSearch.ts) built on a completely different
// mechanism (messages.list + q + an after:<timestamp> cursor, not history.list — Gmail's history API has
// no search-query param at all, so a query-scoped trigger can't be built on this file's mechanism).

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";
import { config } from "../../../config";

export interface GmailHistoryCursor {
  historyId: string;
}

export interface NewEmailReceivedEvent {
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

const newEmailReceivedPayload: z.ZodType<NewEmailReceivedEvent> = z.object({
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

// `history.list`'s own messagesAdded[].message ALREADY carries labelIds (and threadId) — confirmed against
// a real live account, not assumed: a raw history.list call returned e.g.
// { "messagesAdded": [{ "message": { "id": "...", "threadId": "...", "labelIds": ["DRAFT"] } }] } with NO
// extra fetch. Pipedream's real polling-history.mjs filterHistory() filters on exactly this embedded field
// too (`item.messagesAdded[0].message.labelIds`), never a separate messages.get just to check a label. An
// earlier version of this file fetched full message metadata for EVERY messageAdded id first and only
// filtered afterward — wasteful (fetching metadata for messages about to be thrown away) and NOT what the
// verified reference implementation does.
interface GmailHistoryListResponse {
  history?: { messagesAdded?: { message: { id: string; threadId?: string; labelIds?: string[] } }[] }[];
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
    throw new Error(`Gmail new_email_received trigger: failed to seed historyId (${res.status}): ${await describeGoogleApiError(res)}`);
  }
  const profile = (await res.json()) as GmailProfileResponse;
  return { historyId: profile.historyId };
}

export const newEmailReceived: TriggerDefinition<GmailHistoryCursor, NewEmailReceivedEvent> = {
  key: "new_email_received",
  description:
    "Fires when a new email is received into the connected Gmail account's inbox (requires the INBOX label — creating/editing a draft, sending mail, and Gmail Chat messages are all excluded; mail a filter auto-archives on arrival is excluded too, same default Pipedream's own new-email-received source uses). Cursor-based (Gmail historyId, not a timer) — a delayed or restarted worker always resumes exactly where it left off with no gaps and no duplicates, it just delivers late, never wrong; see newEmailMatchingSearch.ts if you need to scope to a search query instead of the whole inbox.",
  mode: "poll",
  // 8 min, per spec. (For reference: Pipedream's real DEFAULT_POLLING_SOURCE_TIMER_INTERVAL is 15 min,
  // Composio's minimum is also 15 min — both verified from real source/docs during R&D. 8 min here is a
  // deliberate choice, not derived from either.) Overridable per-subscription (src/api/trigger_routes.ts),
  // not a fixed global setting — see src/core/scheduler.ts's header for why there's no global interval.
  defaultPollIntervalMs: config.apps.gmail.GMAIL_POLL_INTERVAL_MS, // env-configurable, default 8 min — see config.ts's comment
  payload: newEmailReceivedPayload,
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
      throw new Error(`Gmail new_email_received trigger failed (${res.status}): ${data.error?.message ?? res.statusText}`);
    }

    const addedMessages = (data.history ?? []).flatMap((h) => h.messagesAdded ?? []).map((m) => m.message);

    // Require INBOX rather than excluding DRAFT/SENT (an earlier version of this filter did that, and it
    // was a real bug: an exclude-list only blocks the labels you thought of — it still misfires on Gmail
    // Chat messages (CHAT label), or any other non-arrival system label Google adds later. Same
    // positive-allowlist shape as Pipedream's real gmail-new-email-received source (default `labels:
    // ["INBOX"]`, PipedreamHQ/pipedream's components/gmail/sources/common/polling-history.mjs).
    //
// Filtered BEFORE fetching per-message metadata (labelIds already came from the history.list response
    // above, see the interface comment) — a message that's going to be dropped never costs a messages.get
    // call at all, unlike the earlier fetch-everything-then-filter version.
    const uniqueIds = [...new Set(addedMessages.filter((m) => (m.labelIds ?? []).includes("INBOX")).map((m) => m.id))];

    // A single message's fetch failing here must NOT throw and abort the whole poll() call — if it did,
    // nextCursor below would never be returned, the cursor would stay stuck at this exact historyId
    // forever, and EVERY future poll would re-fetch the same history range, hit the same missing message,
    // and fail again — permanently breaking this trigger for one bad message (e.g. one that was deleted in
    // the gap between history.list listing it and this messages.get call, a real, not-hypothetical race).
    // Skip and log instead; every other message in this batch still gets delivered, the cursor still
    // advances, and the trigger keeps working.
    const events = (
      await Promise.all(
        uniqueIds.map(async (id): Promise<NewEmailReceivedEvent | null> => {
          const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
          msgUrl.searchParams.set("format", "metadata");
          msgUrl.searchParams.append("metadataHeaders", "From");
          msgUrl.searchParams.append("metadataHeaders", "To");
          msgUrl.searchParams.append("metadataHeaders", "Subject");
          const msgRes = await fetch(msgUrl, { headers: authHeaders });
          if (!msgRes.ok) {
            console.warn(`[gmail new_email_received] skipping message ${id}: fetch failed (${msgRes.status}): ${await describeGoogleApiError(msgRes)}`);
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
    ).filter((event): event is NewEmailReceivedEvent => event !== null);

    return { events, nextCursor: { historyId: data.historyId } };
  },
};

// Verified against Pipedream's real gmail-new-email-matching-search source (PipedreamHQ/pipedream,
// components/gmail/sources/new-email-matching-search/new-email-matching-search.mjs + its shared
// common/polling-messages.mjs) — a DELIBERATELY DIFFERENT mechanism from newEmailReceived.ts's
// history.list/historyId cursor. Gmail's history.list has no free-text search param at all, so a
// query-scoped trigger can only be built on messages.list + q — and messages.list has no historyId cursor
// either, only pagination. Pipedream's real fix: track a plain timestamp (`lastDate`, ms) in the source's
// own db, and on every poll append `after:<epoch_seconds>` to the caller's query so Gmail's search index
// itself does the "what's new" filtering, then advance lastDate to the max internalDate seen.
//
// One gap in Pipedream's own version: `after:` has whole-SECOND granularity, but more than one message can
// share the same second, and querying `after:<lastSecond>` again next poll is INCLUSIVE of that second —
// so a naive version re-fetches (and would re-deliver) every message from that exact boundary second on
// every subsequent poll. Pipedream papers over this at the platform level (`dedupe: "unique"` on the
// source, keyed by message id) — a guarantee we don't have here, so this cursor also carries
// `seen_ids_at_boundary`: the ids already delivered at the current boundary second, skipped if seen again.
// Anything from a second strictly before the boundary is already excluded by the `after:` query itself, so
// the remembered set never needs to grow beyond "whatever shares the single newest second."

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";
import { config } from "../../../config";

export interface SearchCursor {
  after_epoch_seconds: number;
  seen_ids_at_boundary: string[];
}

export interface NewEmailMatchingSearchConfig {
  query: string; // raw Gmail search query, e.g. "from:boss@company.com has:attachment" — required, this
  // trigger has no meaning without one (an empty query is just "every message", which is new_email_received).
}

const newEmailMatchingSearchConfig: z.ZodType<NewEmailMatchingSearchConfig> = z.object({
  query: z.string().min(1),
});

export interface NewEmailMatchingSearchEvent {
  message_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  received_at: string;
}

const newEmailMatchingSearchPayload: z.ZodType<NewEmailMatchingSearchEvent> = z.object({
  message_id: z.string(),
  thread_id: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  snippet: z.string(),
  received_at: z.string(),
});

interface GmailMessageListResponse {
  messages?: { id: string }[];
}

interface GmailMessageGetResponse {
  id: string;
  threadId: string;
  snippet: string;
  internalDate: string; // epoch millis, as a string
  payload: { headers: { name: string; value: string }[] };
}

function header(msg: GmailMessageGetResponse, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// Same "GMAIL_SEARCH_MAX_RESULTS" ceiling reasoning as list_recent_emails/list_spam_emails — 50, not
// Pipedream's 100, this project's own consistent cap everywhere else a Gmail list is paged.
const MAX_RESULTS_PER_POLL = 50;

export const newEmailMatchingSearch: TriggerDefinition<SearchCursor, NewEmailMatchingSearchEvent, NewEmailMatchingSearchConfig> = {
  key: "new_email_matching_search",
  description:
    "Fires when a new email matching config.query (Gmail's own search syntax, e.g. \"from:boss@company.com has:attachment\") arrives anywhere Gmail's search covers. config.query is required. Built on messages.list + a timestamp cursor, not historyId — Gmail's history API has no search-query param — but still gap-free and dedup-safe across a delayed/restarted worker: an after:<timestamp> re-query only ever advances forward, and messages sharing the exact boundary second are tracked separately so they're never redelivered.",
  mode: "poll",
  defaultPollIntervalMs: config.apps.gmail.GMAIL_POLL_INTERVAL_MS,
  payload: newEmailMatchingSearchPayload,
  config: newEmailMatchingSearchConfig,
  async poll(connection, cursor, triggerConfig) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    if (!triggerConfig?.query) {
      throw new Error("new_email_matching_search trigger_instance has no config.query — subscribe with { config: { query: \"...\" } }");
    }
    const authHeaders = { Authorization: `Bearer ${connection.secrets.access_token}` };

    if (!cursor) {
      // First poll ever — seed to "now", don't backfill everything currently matching the query as "new".
      // Same no-backfill convention every other Gmail trigger here follows.
      return { events: [], nextCursor: { after_epoch_seconds: Math.floor(Date.now() / 1000), seen_ids_at_boundary: [] } };
    }

    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(MAX_RESULTS_PER_POLL));
    listUrl.searchParams.set("q", `${triggerConfig.query} after:${cursor.after_epoch_seconds}`.trim());

    const listRes = await fetch(listUrl, { headers: authHeaders });
    if (!listRes.ok) {
      throw new Error(`Gmail new_email_matching_search trigger failed (${listRes.status}): ${await describeGoogleApiError(listRes)}`);
    }
    const { messages = [] } = (await listRes.json()) as GmailMessageListResponse;

    // Drop ids already delivered at the current boundary second before spending a fetch on them — see this
    // file's header comment on why `after:` alone can hand back the same boundary-second message twice.
    const seenAtBoundary = new Set(cursor.seen_ids_at_boundary);
    const candidateIds = messages.map((m) => m.id).filter((id) => !seenAtBoundary.has(id));

    // A single message's fetch failing must NOT throw and abort the whole poll() call — same reasoning as
    // newEmailReceived.ts: it would leave nextCursor unreturned, permanently stuck re-querying the same
    // after: window and hitting the same missing message forever. Skip and log instead.
    const messagesDetail = (
      await Promise.all(
        candidateIds.map(async (id): Promise<GmailMessageGetResponse | null> => {
          const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
          msgUrl.searchParams.set("format", "metadata");
          msgUrl.searchParams.append("metadataHeaders", "From");
          msgUrl.searchParams.append("metadataHeaders", "To");
          msgUrl.searchParams.append("metadataHeaders", "Subject");
          const msgRes = await fetch(msgUrl, { headers: authHeaders });
          if (!msgRes.ok) {
            console.warn(`[gmail new_email_matching_search] skipping message ${id}: fetch failed (${msgRes.status}): ${await describeGoogleApiError(msgRes)}`);
            return null;
          }
          return (await msgRes.json()) as GmailMessageGetResponse;
        }),
      )
    ).filter((msg): msg is GmailMessageGetResponse => msg !== null);

    const events = messagesDetail.map(
      (msg): NewEmailMatchingSearchEvent => ({
        message_id: msg.id,
        thread_id: msg.threadId,
        from: header(msg, "From"),
        to: header(msg, "To"),
        subject: header(msg, "Subject"),
        snippet: msg.snippet,
        received_at: new Date(Number(msg.internalDate)).toISOString(),
      }),
    );

    if (messagesDetail.length === 0) {
      // Nothing new — cursor stays exactly as-is (not "advance to now"): the next poll must still see
      // anything that arrived in the gap, and re-querying the same after: bound is always safe/idempotent.
      return { events, nextCursor: cursor };
    }

    const maxEpochSeconds = Math.max(cursor.after_epoch_seconds, ...messagesDetail.map((m) => Math.floor(Number(m.internalDate) / 1000)));
    const idsAtNewBoundary = messagesDetail.filter((m) => Math.floor(Number(m.internalDate) / 1000) === maxEpochSeconds).map((m) => m.id);
    // Carry forward any previously-seen boundary ids too, in case this poll's `after:` window (inclusive of
    // the old boundary second) still surfaced none of the OLD boundary's siblings needing re-checking — the
    // union is always correct and never grows past "ids sharing the single newest second".
    const carriedForward = maxEpochSeconds === cursor.after_epoch_seconds ? cursor.seen_ids_at_boundary : [];

    return {
      events,
      nextCursor: {
        after_epoch_seconds: maxEpochSeconds,
        seen_ids_at_boundary: [...new Set([...carriedForward, ...idsAtNewBoundary])],
      },
    };
  },
};

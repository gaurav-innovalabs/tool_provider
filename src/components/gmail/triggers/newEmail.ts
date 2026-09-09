// Phase 3. Reference: research/gmail-deep-dive.md recommendation — poll via history.list + historyId
// cursor (Pipedream's pattern), NOT messages.list + timestamp (n8n/Activepieces' pattern, which needed
// 4 extra tuning constants to be correct at the edges).

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

export const newEmail: TriggerDefinition<GmailHistoryCursor, NewEmailEvent> = {
  key: "new_email",
  description: "Fires when a new email arrives in the connected Gmail account.",
  mode: "poll",
  async poll(_connection, _cursor) {
    // TODO:
    // - if cursor is null: seed it from users.getProfile().historyId (don't backfill all history on first poll).
    // - else: users.history.list({ startHistoryId: cursor.historyId, historyTypes: ["messageAdded"] }).
    // - on 404 (historyId expired/out of retention window): reseed from getProfile(), per gmail-deep-dive.md.
    // - map history records -> NewEmailEvent[], return { events, nextCursor: { historyId: <latest> } }.
    // TODO(ask): Pub/Sub watch() push mode is explicitly OUT of Phase 1-3 scope (needs its own GCP topic +
    // IAM + 7-day renewal scheduler, per gmail-deep-dive.md recommendation #1) — confirm we're deferring it
    // to a later phase entirely rather than stubbing a `mode: "webhook"` variant now.
    throw new Error("not implemented");
  },
};

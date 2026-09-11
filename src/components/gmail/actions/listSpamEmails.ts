// Same shape as listRecentEmails.ts, scoped to the SPAM label via messages.list's labelIds param (not a
// q=in:spam text query — labelIds is the exact, non-ambiguous way to select a system label). Gmail excludes
// SPAM (and TRASH) from every plain messages.list/search by default, which is why list_recent_emails can
// never see spam even with a query — this is the dedicated way to actually read it.
//
// Cross-checked against Pipedream's real gmail-find-email action (PipedreamHQ/pipedream, components/gmail/
// actions/find-email/find-email.mjs) — it exposes the equivalent as a `labelIds` prop plus a separate
// `includeSpamTrash` boolean (Gmail API's own real users.messages.list param, default false). We don't need
// that second flag here: Gmail's API docs state includeSpamTrash is ignored once labelIds is set to SPAM or
// TRASH — labelIds=SPAM alone is sufficient, which is also what the live run against a real account below
// confirmed (real spam messages came back with no includeSpamTrash param sent at all).

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z.object({
  max_results: z.number().int().min(1).max(50).default(10),
});

const emailSummary = z.object({
  id: z.string(),
  thread_id: z.string(),
  from: z.string(),
  subject: z.string(),
  snippet: z.string(),
  received_at: z.string(), // ISO timestamp, derived from the message's internalDate
});

const output = z.array(emailSummary);

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

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

export const listSpamEmails: ActionDefinition<Input, Output> = {
  key: "list_spam_emails",
  description: "List emails Gmail has classified as spam. Use modify_message_labels (remove SPAM, add INBOX) to rescue a false positive, or trash_message to discard one.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const authHeaders = { Authorization: `Bearer ${connection.secrets.access_token}` };

    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(params.max_results));
    listUrl.searchParams.set("labelIds", "SPAM");

    const listRes = await fetch(listUrl, { headers: authHeaders });
    if (!listRes.ok) {
      throw new Error(`Gmail list_spam_emails failed (${listRes.status}): ${await describeGoogleApiError(listRes)}`);
    }
    const { messages = [] } = (await listRes.json()) as GmailMessageListResponse;

    const details = await Promise.all(
      messages.map(async (m) => {
        const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`);
        url.searchParams.set("format", "metadata");
        url.searchParams.append("metadataHeaders", "From");
        url.searchParams.append("metadataHeaders", "Subject");
        const res = await fetch(url, { headers: authHeaders });
        if (!res.ok) {
          throw new Error(`Gmail spam message fetch failed for ${m.id} (${res.status}): ${await describeGoogleApiError(res)}`);
        }
        return (await res.json()) as GmailMessageGetResponse;
      }),
    );

    return details.map((msg) => ({
      id: msg.id,
      thread_id: msg.threadId,
      from: header(msg, "From"),
      subject: header(msg, "Subject"),
      snippet: msg.snippet,
      received_at: new Date(Number(msg.internalDate)).toISOString(),
    }));
  },
};

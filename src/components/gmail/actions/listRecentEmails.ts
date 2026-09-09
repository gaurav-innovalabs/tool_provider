import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  max_results: z.number().int().min(1).max(50).default(10),
  query: z.string().optional(), // raw Gmail search query, e.g. "is:unread"
});

const emailSummary = z.object({
  id: z.string(),
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
  snippet: string;
  internalDate: string; // epoch millis, as a string
  payload: { headers: { name: string; value: string }[] };
}

function header(msg: GmailMessageGetResponse, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export const listRecentEmails: ActionDefinition<Input, Output> = {
  key: "list_recent_emails",
  description: "List recent emails in the connected Gmail account, optionally filtered by a search query.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const authHeaders = { Authorization: `Bearer ${connection.secrets!.access_token}` };

    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(params.max_results));
    if (params.query) listUrl.searchParams.set("q", params.query);

    const listRes = await fetch(listUrl, { headers: authHeaders });
    if (!listRes.ok) {
      throw new Error(`Gmail list_recent_emails failed (${listRes.status}): ${await listRes.text()}`);
    }
    const { messages = [] } = (await listRes.json()) as GmailMessageListResponse;

    // format=metadata + metadataHeaders avoids pulling the full message body per item — cheap N calls,
    // still lighter than fetching full payloads for a "just show me recent mail" action.
    const details = await Promise.all(
      messages.map(async (m) => {
        const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`);
        url.searchParams.set("format", "metadata");
        url.searchParams.append("metadataHeaders", "From");
        url.searchParams.append("metadataHeaders", "Subject");
        const res = await fetch(url, { headers: authHeaders });
        if (!res.ok) {
          throw new Error(`Gmail message fetch failed for ${m.id} (${res.status}): ${await res.text()}`);
        }
        return (await res.json()) as GmailMessageGetResponse;
      }),
    );

    return details.map((msg) => ({
      id: msg.id,
      from: header(msg, "From"),
      subject: header(msg, "Subject"),
      snippet: msg.snippet,
      received_at: new Date(Number(msg.internalDate)).toISOString(),
    }));
  },
};

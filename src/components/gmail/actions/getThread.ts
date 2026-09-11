import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z.object({
  thread_id: z.string().min(1).describe("Gmail thread id, e.g. the `thread_id` field from get_email or list_recent_emails"),
});

const threadMessage = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  received_at: z.string(),
  body_text: z.string(),
  label_ids: z.array(z.string()),
});

const output = z.object({
  thread_id: z.string(),
  messages: z.array(threadMessage),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface GmailMessagePart {
  mimeType: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

interface GmailMessageGetResponse {
  id: string;
  internalDate: string; // epoch millis, as a string
  labelIds?: string[];
  payload: { headers: { name: string; value: string }[] } & GmailMessagePart;
}

interface GmailThreadGetResponse {
  id: string;
  messages?: GmailMessageGetResponse[];
}

function header(msg: GmailMessageGetResponse, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

// Same depth-first walk as getEmail.ts's extractBodies, plain-text only — a thread view is for reading the
// conversation, not rendering HTML.
function extractText(part: GmailMessagePart): string | undefined {
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  if (part.parts) {
    for (const child of part.parts) {
      const found = extractText(child);
      if (found) return found;
    }
  }
  return undefined;
}

export const getThread: ActionDefinition<Input, Output> = {
  key: "get_thread",
  description: "Get every message in a Gmail thread (conversation) in order — use this instead of get_email when you need the full back-and-forth, not just one message.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${params.thread_id}`);
    url.searchParams.set("format", "full");

    const res = await fetch(url, { headers: { Authorization: `Bearer ${connection.secrets.access_token}` } });
    if (!res.ok) {
      throw new Error(`Gmail get_thread failed (${res.status}): ${await describeGoogleApiError(res)}`);
    }
    const thread = (await res.json()) as GmailThreadGetResponse;

    return {
      thread_id: thread.id,
      messages: (thread.messages ?? []).map((msg) => ({
        id: msg.id,
        from: header(msg, "From"),
        to: header(msg, "To"),
        subject: header(msg, "Subject"),
        received_at: new Date(Number(msg.internalDate)).toISOString(),
        body_text: extractText(msg.payload) ?? "",
        label_ids: msg.labelIds ?? [],
      })),
    };
  },
};

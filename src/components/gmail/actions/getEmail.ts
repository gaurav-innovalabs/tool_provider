import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  message_id: z.string().describe("Gmail message id, e.g. the `id` field from list_recent_emails"),
});

const output = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  received_at: z.string(),
  body_text: z.string(),
  body_html: z.string().optional(),
  label_ids: z.array(z.string()),
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

function header(msg: GmailMessageGetResponse, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

// Gmail nests the actual body under `payload.parts` for any multipart message (text/plain + text/html as
// alternatives, sometimes nested again under a multipart/alternative or multipart/mixed wrapper) — a
// simple top-level `payload.body.data` read only works for single-part plain-text messages. Walk the tree
// depth-first, taking the first text/plain and text/html leaf found (don't rely on Gmail's part ordering).
function extractBodies(part: GmailMessagePart): { text?: string; html?: string } {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return { text: decodeBase64Url(part.body.data) };
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return { html: decodeBase64Url(part.body.data) };
  }
  if (part.parts) {
    let text: string | undefined;
    let html: string | undefined;
    for (const child of part.parts) {
      const found = extractBodies(child);
      text ??= found.text;
      html ??= found.html;
    }
    return { text, html };
  }
  return {};
}

export const getEmail: ActionDefinition<Input, Output> = {
  key: "get_email",
  description:
    "Get the full content of one Gmail message by id (headers + decoded plain-text/HTML body) — list_recent_emails only returns a short snippet, use this to actually read an email.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${params.message_id}`);
    url.searchParams.set("format", "full");

    const res = await fetch(url, { headers: { Authorization: `Bearer ${connection.secrets.access_token}` } });
    if (!res.ok) {
      throw new Error(`Gmail get_email failed (${res.status}): ${await res.text()}`);
    }
    const msg = (await res.json()) as GmailMessageGetResponse;
    const { text, html } = extractBodies(msg.payload);

    return {
      id: msg.id,
      from: header(msg, "From"),
      to: header(msg, "To"),
      subject: header(msg, "Subject"),
      received_at: new Date(Number(msg.internalDate)).toISOString(),
      // Fall back to "" rather than html-stripped-to-text — a plain-text-only client can still read html
      // via body_html; inventing a fake plain-text rendering here would be lossy and non-obvious.
      body_text: text ?? "",
      body_html: html,
      label_ids: msg.labelIds ?? [],
    };
  },
};

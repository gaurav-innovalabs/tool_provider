import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z.object({
  draft_id: z.string().min(1).describe("Gmail draft id, e.g. the `draft_id` field from list_drafts or create_draft"),
});

const output = z.object({
  draft_id: z.string(),
  message_id: z.string(),
  to: z.string(),
  subject: z.string(),
  body_text: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface GmailMessagePart {
  mimeType: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

interface GmailDraftGetResponse {
  id: string;
  message: {
    id: string;
    payload: { headers: { name: string; value: string }[] } & GmailMessagePart;
  };
}

function header(msg: GmailDraftGetResponse["message"], name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

// Same depth-first walk as getEmail.ts's extractBodies, trimmed to plain text only — a draft composed via
// create_draft/update_draft here is always plain text (see toBase64Url in those two files), so there's no
// html leaf to also extract.
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

export const getDraft: ActionDefinition<Input, Output> = {
  key: "get_draft",
  description: "Get the full content (recipient, subject, body) of one Gmail draft by id.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${params.draft_id}`);
    url.searchParams.set("format", "full");

    const res = await fetch(url, { headers: { Authorization: `Bearer ${connection.secrets.access_token}` } });
    if (!res.ok) {
      throw new Error(`Gmail get_draft failed (${res.status}): ${await describeGoogleApiError(res)}`);
    }
    const draft = (await res.json()) as GmailDraftGetResponse;

    return {
      draft_id: draft.id,
      message_id: draft.message.id,
      to: header(draft.message, "To"),
      subject: header(draft.message, "Subject"),
      body_text: extractText(draft.message.payload) ?? "",
    };
  },
};

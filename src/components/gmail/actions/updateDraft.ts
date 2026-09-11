// Gmail's drafts.update (PUT /drafts/{id}) fully replaces the draft's message content, same as
// createDraft.ts's drafts.create — it's a real, documented endpoint (contrary to the earlier assumption
// that no Gmail tooling supports editing an existing draft; Pipedream/most MCP servers just don't happen to
// expose it). Same "lite" shape as createDraft.ts: no attachments, no from-name/from-email aliasing.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z.object({
  draft_id: z.string().min(1).describe("Gmail draft id, e.g. the `draft_id` field from list_drafts or create_draft"),
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string(),
});

const output = z.object({
  draft_id: z.string(),
  message_id: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

function toBase64Url(str: string): string {
  return Buffer.from(str).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface GmailDraftUpdateResponse {
  id: string;
  message: { id: string };
}

export const updateDraft: ActionDefinition<Input, Output> = {
  key: "update_draft",
  description: "Replace the content (to/subject/body) of an existing unsent Gmail draft.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const raw = toBase64Url(
      [`To: ${params.to}`, `Subject: ${params.subject}`, "Content-Type: text/plain; charset=utf-8", "", params.body].join(
        "\r\n",
      ),
    );

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${params.draft_id}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${connection.secrets.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { raw } }),
    });

    if (!res.ok) {
      throw new Error(`Gmail update_draft failed (${res.status}): ${await describeGoogleApiError(res)}`);
    }

    const data = (await res.json()) as GmailDraftUpdateResponse;
    return { draft_id: data.id, message_id: data.message.id };
  },
};

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z.object({
  draft_id: z.string().min(1).describe("Gmail draft id, e.g. the `draft_id` field from list_drafts or create_draft"),
});

const output = z.object({
  message_id: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface GmailDraftSendResponse {
  id: string;
}

export const sendDraft: ActionDefinition<Input, Output> = {
  key: "send_draft",
  description: "Send an existing unsent Gmail draft as-is. The draft is consumed by sending — it no longer appears in list_drafts afterward.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: params.draft_id }),
    });

    if (!res.ok) {
      throw new Error(`Gmail send_draft failed (${res.status}): ${await describeGoogleApiError(res)}`);
    }

    const data = (await res.json()) as GmailDraftSendResponse;
    return { message_id: data.id };
  },
};

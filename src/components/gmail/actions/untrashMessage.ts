import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z.object({
  message_id: z.string().min(1).describe("Gmail message id, e.g. the `id` field from list_recent_emails"),
});

const output = z.object({
  id: z.string(),
  label_ids: z.array(z.string()),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface GmailMessageResponse {
  id: string;
  labelIds?: string[];
}

export const untrashMessage: ActionDefinition<Input, Output> = {
  key: "untrash_message",
  description: "Restore a Gmail message out of Trash (removes the TRASH label) back to its prior location.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${params.message_id}/untrash`, {
      method: "POST",
      headers: { Authorization: `Bearer ${connection.secrets.access_token}` },
    });
    if (!res.ok) {
      throw new Error(`Gmail untrash_message failed (${res.status}): ${await describeGoogleApiError(res)}`);
    }

    const data = (await res.json()) as GmailMessageResponse;
    return { id: data.id, label_ids: data.labelIds ?? [] };
  },
};

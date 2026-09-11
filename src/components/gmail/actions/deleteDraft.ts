import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z.object({
  draft_id: z.string().min(1).describe("Gmail draft id, e.g. the `draft_id` field from list_drafts or create_draft"),
});

const output = z.object({
  deleted: z.literal(true),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

export const deleteDraft: ActionDefinition<Input, Output> = {
  key: "delete_draft",
  description: "Permanently delete an unsent Gmail draft. This is immediate and unrecoverable (unlike trash_message, there is no undo for a deleted draft).",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${params.draft_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${connection.secrets.access_token}` },
    });
    // Gmail returns 204 No Content on success — no JSON body to parse.
    if (!res.ok) {
      throw new Error(`Gmail delete_draft failed (${res.status}): ${await describeGoogleApiError(res)}`);
    }

    return { deleted: true as const };
  },
};

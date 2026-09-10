import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z.object({
  label_id: z.string().min(1),
});

const output = z.object({
  deleted: z.literal(true),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

export const deleteLabel: ActionDefinition<Input, Output> = {
  key: "delete_label",
  description: "Delete a user label from the connected Gmail account. System labels cannot be deleted.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/labels/${params.label_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${connection.secrets!.access_token}` },
    });
    // Gmail returns 204 No Content on success — no JSON body to parse.
    if (!res.ok) {
      throw new Error(`Gmail delete_label failed (${res.status}): ${await describeGoogleApiError(res)}`);
    }

    return { deleted: true as const };
  },
};

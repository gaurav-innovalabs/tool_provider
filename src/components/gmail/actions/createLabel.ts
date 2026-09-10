import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z.object({
  name: z.string().min(1),
  // TODO(ask): expose label_list_visibility/message_list_visibility (Gmail's show/hide-in-sidebar
  // options)? Skipped for the first cut — Gmail defaults both to "show" if omitted, which is fine.
});

const output = z.object({
  id: z.string(),
  name: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface GmailLabelCreateResponse {
  id: string;
  name: string;
}

export const createLabel: ActionDefinition<Input, Output> = {
  key: "create_label",
  description: "Create a new user label in the connected Gmail account.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets!.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: params.name }),
    });
    if (!res.ok) {
      throw new Error(`Gmail create_label failed (${res.status}): ${await describeGoogleApiError(res)}`);
    }

    const data = (await res.json()) as GmailLabelCreateResponse;
    return { id: data.id, name: data.name };
  },
};

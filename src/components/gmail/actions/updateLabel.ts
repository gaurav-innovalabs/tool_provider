import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  label_id: z.string().min(1),
  name: z.string().min(1), // Gmail's labels.patch supports more fields; only rename is exposed for now
});

const output = z.object({
  id: z.string(),
  name: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface GmailLabelPatchResponse {
  id: string;
  name: string;
}

export const updateLabel: ActionDefinition<Input, Output> = {
  key: "update_label",
  description: "Rename an existing Gmail label. System labels cannot be renamed (Gmail will reject it).",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/labels/${params.label_id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${connection.secrets!.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: params.name }),
    });
    if (!res.ok) {
      throw new Error(`Gmail update_label failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as GmailLabelPatchResponse;
    return { id: data.id, name: data.name };
  },
};

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({});

const label = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["system", "user"]),
});

const output = z.array(label);

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface GmailLabelsListResponse {
  labels?: { id: string; name: string; type: string }[];
}

export const listLabels: ActionDefinition<Input, Output> = {
  key: "list_labels",
  description: "List all labels (system and user-created) in the connected Gmail account.",
  input,
  output,
  async run(connection) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      headers: { Authorization: `Bearer ${connection.secrets!.access_token}` },
    });
    if (!res.ok) {
      throw new Error(`Gmail list_labels failed (${res.status}): ${await res.text()}`);
    }

    const { labels = [] } = (await res.json()) as GmailLabelsListResponse;
    return labels.map((l) => ({ id: l.id, name: l.name, type: l.type === "system" ? "system" : "user" }) as const);
  },
};

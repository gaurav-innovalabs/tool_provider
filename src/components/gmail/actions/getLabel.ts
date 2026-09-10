import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z.object({
  label_id: z.string().min(1),
});

const output = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["system", "user"]),
  messages_total: z.number().optional(),
  messages_unread: z.number().optional(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface GmailLabelGetResponse {
  id: string;
  name: string;
  type: string;
  messagesTotal?: number;
  messagesUnread?: number;
}

export const getLabel: ActionDefinition<Input, Output> = {
  key: "get_label",
  description: "Get details of a single Gmail label, including message counts.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/labels/${params.label_id}`, {
      headers: { Authorization: `Bearer ${connection.secrets!.access_token}` },
    });
    if (!res.ok) {
      throw new Error(`Gmail get_label failed (${res.status}): ${await describeGoogleApiError(res)}`);
    }

    const data = (await res.json()) as GmailLabelGetResponse;
    return {
      id: data.id,
      name: data.name,
      type: data.type === "system" ? "system" : "user",
      messages_total: data.messagesTotal,
      messages_unread: data.messagesUnread,
    };
  },
};

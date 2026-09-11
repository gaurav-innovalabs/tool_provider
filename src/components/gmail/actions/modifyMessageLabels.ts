// Single Gmail API call (messages.modify) that covers most inbox-state changes: in Gmail, archive / star /
// unstar / mark-read / mark-unread / apply-a-user-label are all just label add/remove under the hood —
// same primitive Pipedream's real gmail-modify-labels action and Google's own official Gmail MCP
// (label_message/unlabel_message) build on. Common recipes: archive -> remove_label_ids: ["INBOX"]; star ->
// add_label_ids: ["STARRED"]; mark read -> remove_label_ids: ["UNREAD"].

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z
  .object({
    message_id: z.string().min(1).describe("Gmail message id, e.g. the `id` field from list_recent_emails"),
    add_label_ids: z.array(z.string()).default([]).describe("Label ids to add, e.g. [\"STARRED\"] or a user label's id from list_labels"),
    remove_label_ids: z.array(z.string()).default([]).describe("Label ids to remove, e.g. [\"UNREAD\"] or [\"INBOX\"] to archive"),
  })
  .refine((v) => v.add_label_ids.length > 0 || v.remove_label_ids.length > 0, {
    message: "At least one of add_label_ids or remove_label_ids must be non-empty",
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

export const modifyMessageLabels: ActionDefinition<Input, Output> = {
  key: "modify_message_labels",
  description:
    "Add and/or remove labels on a Gmail message — the underlying primitive for archive (remove INBOX), star/unstar (STARRED), mark read/unread (UNREAD), and applying a user label.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${params.message_id}/modify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ addLabelIds: params.add_label_ids, removeLabelIds: params.remove_label_ids }),
    });
    if (!res.ok) {
      throw new Error(`Gmail modify_message_labels failed (${res.status}): ${await describeGoogleApiError(res)}`);
    }

    const data = (await res.json()) as GmailMessageResponse;
    return { id: data.id, label_ids: data.labelIds ?? [] };
  },
};

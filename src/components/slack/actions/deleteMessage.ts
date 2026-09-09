// API reference: https://docs.slack.dev/reference/methods/chat.delete (bot scope: chat:write)
// Response shape: { ok, channel, ts } on success — a bot token can only delete messages it posted itself.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  channel: z.string().min(1),
  ts: z.string().min(1),
  // Must match how the message was originally sent, same reasoning as update_message.
  as_user: z.boolean().default(false),
});

const output = z.object({
  ts: z.string(),
  channel: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

export const deleteMessage: ActionDefinition<Input, Output> = {
  key: "delete_message",
  description: "Delete a Slack message. as_user must match how it was originally sent (bot can only delete its own messages).",
  input,
  output,
  async run(connection, params) {
    const token = params.as_user ? connection.secrets?.user_access_token : connection.secrets?.access_token;
    if (!token) {
      throw new Error(
        params.as_user
          ? `Connection ${connection.connection_id} has no user_access_token in secrets — reconnect Slack with user scopes granted.`
          : `Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`,
      );
    }

    const res = await fetch("https://slack.com/api/chat.delete", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: params.channel, ts: params.ts }),
    });

    const data = (await res.json()) as SlackApiResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack delete_message failed: ${data.error ?? res.statusText}`);
    }

    return { ts: data.ts!, channel: data.channel! };
  },
};

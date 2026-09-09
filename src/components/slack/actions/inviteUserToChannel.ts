// API reference: https://docs.slack.dev/reference/methods/conversations.invite (bot scope: channels:manage)
// Response shape: { ok, channel: { id, name, ... } } on success. `users` is a comma-separated id list on
// the wire, hence the .join(",") below — the input schema keeps it as a typed array for the caller.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  channel: z.string().min(1),
  users: z.array(z.string().min(1)).min(1), // Slack user ids
});

const output = z.object({
  id: z.string(),
  name: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  channel?: { id: string; name: string };
}

export const inviteUserToChannel: ActionDefinition<Input, Output> = {
  key: "invite_user_to_channel",
  description: "Invite one or more users to a Slack channel.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch("https://slack.com/api/conversations.invite", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets!.access_token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: params.channel, users: params.users.join(",") }),
    });

    const data = (await res.json()) as SlackApiResponse;
    if (!res.ok || !data.ok || !data.channel) {
      throw new Error(`Slack invite_user_to_channel failed: ${data.error ?? res.statusText}`);
    }

    return { id: data.channel.id, name: data.channel.name };
  },
};

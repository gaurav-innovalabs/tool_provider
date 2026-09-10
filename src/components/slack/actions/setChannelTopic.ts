// API reference: https://docs.slack.dev/reference/methods/conversations.setTopic (bot scope: channels:manage)
// Response shape: { ok, topic } on success.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeSlackError } from "../../../lib/slackErrors";

const input = z.object({
  // conversations.setTopic requires the real channel ID — Slack does NOT resolve a "#name" here.
  channel_id: z.string().min(1).describe("Channel ID, e.g. from list_channels — NOT a #channel-name"),
  topic: z.string().min(1),
});

const output = z.object({ topic: z.string() });

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  topic?: string;
}

export const setChannelTopic: ActionDefinition<Input, Output> = {
  key: "set_channel_topic",
  description: "Set the topic for a Slack channel.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch("https://slack.com/api/conversations.setTopic", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets!.access_token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: params.channel_id, topic: params.topic }),
    });

    const data = (await res.json()) as SlackApiResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack set_channel_topic failed: ${describeSlackError(data.error ?? res.statusText)}`);
    }

    return { topic: data.topic ?? params.topic };
  },
};

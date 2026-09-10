// API reference: https://docs.slack.dev/reference/methods/conversations.archive (bot scope: channels:manage)
// Response shape: { ok } on success.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeSlackError } from "../../../lib/slackErrors";

const input = z.object({
  // conversations.archive requires the real channel ID — Slack does NOT resolve a "#name" here.
  channel_id: z.string().min(1).describe("Channel ID, e.g. from list_channels — NOT a #channel-name"),
});

const output = z.object({ ok: z.boolean() });

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

export const archiveChannel: ActionDefinition<Input, Output> = {
  key: "archive_channel",
  description: "Archive a Slack channel.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch("https://slack.com/api/conversations.archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets!.access_token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: params.channel_id }),
    });

    const data = (await res.json()) as SlackApiResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack archive_channel failed: ${describeSlackError(data.error ?? res.statusText)}`);
    }

    return { ok: true };
  },
};

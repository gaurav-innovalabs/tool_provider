// API reference: https://docs.slack.dev/reference/methods/chat.update (bot scope: chat:write)
// Response shape: { ok, channel, ts, text } on success, { ok: false, error } on failure — mismatched
// as_user vs. how the message was originally posted fails with error: "cant_update_message".

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeSlackError } from "../../../lib/slackErrors";

const input = z.object({
  // chat.update requires the real channel ID Slack's own post_message response returned — unlike
  // post_message's `channel` input, Slack does NOT resolve a "#name" here (channel_not_found).
  channel_id: z.string().min(1).describe("Channel ID, e.g. from post_message's own response — NOT a #channel-name"),
  ts: z.string().min(1), // timestamp of the message to edit, as returned by post_message/send_direct_message
  text: z.string().min(1),
  blocks: z.array(z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(),
  // Must match how the message was originally sent — chat.update can only edit a message posted by the
  // same identity (bot or user) that's now calling it. Mismatch fails with Slack's cant_update_message.
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

export const updateMessage: ActionDefinition<Input, Output> = {
  key: "update_message",
  description: "Edit the text/blocks of a previously posted Slack message. as_user must match how it was originally sent.",
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

    const res = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: params.channel_id,
        ts: params.ts,
        text: params.text,
        blocks: params.blocks,
        attachments: params.attachments,
      }),
    });

    const data = (await res.json()) as SlackApiResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack update_message failed: ${describeSlackError(data.error ?? res.statusText)}`);
    }

    return { ts: data.ts!, channel: data.channel! };
  },
};

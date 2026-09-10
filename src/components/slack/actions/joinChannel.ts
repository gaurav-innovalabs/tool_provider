// API reference: https://docs.slack.dev/reference/methods/conversations.join (bot scope: channels:manage,
// already granted — no new scope needed). Response shape: { ok, channel: { id, name, is_member } } on
// success (already_in_channel is idempotent-success per Slack's own docs, not an error).
//
// Why this exists: chat:write.public lets post_message etc. post to a public channel WITHOUT joining it —
// but that's posting permission only. Slack's Events API still requires actual channel MEMBERSHIP to
// deliver message.channels/reaction_added/etc. events FROM that channel — chat:write.public does nothing
// for that. A trigger subscription scoped to (or even unscoped, but reading) a channel the bot never
// joined will silently receive zero events, with no error anywhere — this is exactly that failure mode,
// found by checking get_channel_details' `is_member` field. This action is the fix: join the channel once,
// and Slack starts delivering its events.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeSlackError } from "../../../lib/slackErrors";

const input = z.object({
  // conversations.join requires the real channel ID — Slack does NOT resolve a "#name" here.
  channel_id: z.string().min(1).describe("Channel ID, e.g. from list_channels — NOT a #channel-name"),
});

const output = z.object({
  id: z.string(),
  name: z.string(),
  is_member: z.boolean(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  channel?: { id: string; name: string; is_member: boolean };
}

export const joinChannel: ActionDefinition<Input, Output> = {
  key: "join_channel",
  description:
    "Join a public Slack channel — required for the bot to actually RECEIVE events (message.channels, reaction_added, etc.) from that channel. chat:write.public lets it post there without joining, but posting and receiving events are separate permissions; a trigger subscription scoped to a channel the bot never joined will silently deliver zero events.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets!.access_token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: params.channel_id }),
    });

    const data = (await res.json()) as SlackApiResponse;
    if (!res.ok || !data.ok || !data.channel) {
      throw new Error(`Slack join_channel failed: ${describeSlackError(data.error ?? res.statusText)}`);
    }

    return { id: data.channel.id, name: data.channel.name, is_member: data.channel.is_member };
  },
};

// API reference: https://docs.slack.dev/reference/events/member_joined_channel (bot scope: channels:read)

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";

export interface UserJoinedChannelEvent {
  user: string;
  channel: string;
  inviter: string;
}

const userJoinedChannelPayload: z.ZodType<UserJoinedChannelEvent> = z.object({
  user: z.string(),
  channel: z.string(),
  inviter: z.string(),
});

// Raw shape of a Slack `member_joined_channel` event, per https://api.slack.com/events/member_joined_channel
export interface SlackMemberJoinedChannelEventPayload {
  type: string; // "member_joined_channel"
  user: string;
  channel: string;
  channel_type?: string;
  team?: string;
  inviter?: string;
}

export interface UserJoinedChannelConfig {
  channel_id?: string; // real channel ID, NOT a "#name" — see newMessage.ts's NewMessageConfig comment
}

const userJoinedChannelConfig: z.ZodType<UserJoinedChannelConfig> = z.object({
  channel_id: z.string().optional(),
});

export const userJoinedChannel: TriggerDefinition<unknown, UserJoinedChannelEvent, UserJoinedChannelConfig> = {
  key: "user_joined_channel",
  description: "Fires when a user joins a channel the connected app can see. Pass config.channel_id to scope to one channel.",
  mode: "webhook",
  payload: userJoinedChannelPayload,
  config: userJoinedChannelConfig,
  matchesConfig(rawPayload, config) {
    const event = rawPayload as SlackMemberJoinedChannelEventPayload;
    if (config.channel_id && event.channel !== config.channel_id) return false;
    return true;
  },
  async handleWebhook(_connection, rawPayload) {
    const event = rawPayload as SlackMemberJoinedChannelEventPayload;
    return [
      {
        user: event.user,
        channel: event.channel,
        inviter: event.inviter ?? "",
      },
    ];
  },
};

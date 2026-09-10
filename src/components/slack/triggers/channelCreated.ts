// API reference: https://docs.slack.dev/reference/events/channel_created (bot scope: channels:read).
// Workspace-wide, not scoped to a channel the app is already a member of — fires for any new public
// channel.

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";

export interface ChannelCreatedEvent {
  channel_id: string;
  channel_name: string;
  creator: string;
  created: number; // unix seconds
}

const channelCreatedPayload: z.ZodType<ChannelCreatedEvent> = z.object({
  channel_id: z.string(),
  channel_name: z.string(),
  creator: z.string(),
  created: z.number(),
});

// Raw shape of a Slack `channel_created` event, per https://api.slack.com/events/channel_created
export interface SlackChannelCreatedEventPayload {
  type: string; // "channel_created"
  channel: { id: string; name: string; created: number; creator: string };
}

// No `config`/`matchesConfig` here on purpose — unlike every other Slack trigger in this directory, there
// is no existing channel to scope this to: the channel this event reports doesn't exist until the event
// itself fires. Always fires workspace-wide.
export const channelCreated: TriggerDefinition<unknown, ChannelCreatedEvent> = {
  key: "channel_created",
  description: "Fires when a new public channel is created in the connected workspace. Not scopable — always workspace-wide.",
  mode: "webhook",
  payload: channelCreatedPayload,
  async handleWebhook(_connection, rawPayload) {
    const event = rawPayload as SlackChannelCreatedEventPayload;
    return [
      {
        channel_id: event.channel.id,
        channel_name: event.channel.name,
        creator: event.channel.creator,
        created: event.channel.created,
      },
    ];
  },
};

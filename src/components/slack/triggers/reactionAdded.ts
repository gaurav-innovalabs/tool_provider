// API reference: https://docs.slack.dev/reference/events/reaction_added (bot scope: reactions:read)

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";

export interface ReactionAddedEvent {
  reaction: string;
  user: string; // who added the reaction
  item_user: string; // who authored the reacted-to item
  channel: string;
  ts: string; // the reacted-to message's ts
}

const reactionAddedPayload: z.ZodType<ReactionAddedEvent> = z.object({
  reaction: z.string(),
  user: z.string(),
  item_user: z.string(),
  channel: z.string(),
  ts: z.string(),
});

// Raw shape of a Slack `reaction_added` event, per https://api.slack.com/events/reaction_added
export interface SlackReactionEventPayload {
  type: string; // "reaction_added" | "reaction_removed"
  user: string;
  reaction: string;
  item_user?: string;
  item: { type: string; channel?: string; ts?: string };
  event_ts: string;
}

export interface ReactionAddedConfig {
  channel_id?: string; // real channel ID, NOT a "#name" — see newMessage.ts's NewMessageConfig comment
  // No thread_ts here on purpose: a reaction_added event only carries the reacted-to message's OWN ts
  // (item.ts) — if that message is itself a thread reply, Slack does not include its parent thread_ts on
  // this event, so scoping reactions to "replies within thread X" isn't derivable without an extra
  // conversations.replies lookup. TODO: revisit if that lookup is ever worth adding here.
}

const reactionAddedConfig: z.ZodType<ReactionAddedConfig> = z.object({
  channel_id: z.string().optional(),
});

export const reactionAdded: TriggerDefinition<unknown, ReactionAddedEvent, ReactionAddedConfig> = {
  key: "reaction_added",
  description:
    "Fires when someone adds an emoji reaction to a message in a channel the connected app can see. Pass config.channel_id to scope to one channel.",
  mode: "webhook",
  payload: reactionAddedPayload,
  config: reactionAddedConfig,
  matchesConfig(rawPayload, config) {
    const event = rawPayload as SlackReactionEventPayload;
    if (config.channel_id && event.item.channel !== config.channel_id) return false;
    return true;
  },
  async handleWebhook(_connection, rawPayload) {
    const event = rawPayload as SlackReactionEventPayload;
    return [
      {
        reaction: event.reaction,
        user: event.user,
        item_user: event.item_user ?? "",
        channel: event.item.channel ?? "",
        ts: event.item.ts ?? event.event_ts,
      },
    ];
  },
};

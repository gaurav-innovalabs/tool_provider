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
  // Optional, unlike thread_ts on newMessage.ts: scope to reactions on ONE specific message (its own ts,
  // Slack's item.ts) — e.g. watch a message you just posted for a 👍 reaction. Omit for "any reaction on
  // any message" (optionally still narrowed by channel_id above). Safe to filter on, unlike newMessage's
  // thread_ts gap: item.ts is always present on a reaction_added event, no missing-field edge case.
  message_ts?: string;
}

const reactionAddedConfig: z.ZodType<ReactionAddedConfig> = z.object({
  channel_id: z.string().optional(),
  message_ts: z.string().optional(),
});

export const reactionAdded: TriggerDefinition<unknown, ReactionAddedEvent, ReactionAddedConfig> = {
  key: "reaction_added",
  description:
    "Fires when someone adds an emoji reaction to a message in a channel the connected app can see. Pass config.channel_id to scope to one channel, and/or config.message_ts to scope to reactions on one specific message — omit both to fire for every reaction everywhere.",
  mode: "webhook",
  payload: reactionAddedPayload,
  config: reactionAddedConfig,
  matchesConfig(rawPayload, config) {
    const event = rawPayload as SlackReactionEventPayload;
    if (config.channel_id && event.item.channel !== config.channel_id) return false;
    if (config.message_ts && event.item.ts !== config.message_ts) return false;
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

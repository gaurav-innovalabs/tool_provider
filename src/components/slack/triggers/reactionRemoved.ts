// API reference: https://docs.slack.dev/reference/events/reaction_removed (bot scope: reactions:read)
// Same payload shape as reaction_added (SlackReactionEventPayload) — Slack only differs on `type`, which
// webhook_routes.ts's dispatcher uses to route here instead.

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";
import type { SlackReactionEventPayload } from "./reactionAdded";

export interface ReactionRemovedEvent {
  reaction: string;
  user: string; // who removed the reaction
  item_user: string; // who authored the reacted-to item
  channel: string;
  ts: string; // the reacted-to message's ts
}

const reactionRemovedPayload: z.ZodType<ReactionRemovedEvent> = z.object({
  reaction: z.string(),
  user: z.string(),
  item_user: z.string(),
  channel: z.string(),
  ts: z.string(),
});

export interface ReactionRemovedConfig {
  channel_id?: string; // real channel ID, NOT a "#name"; same "no thread_ts" reasoning as reactionAdded.ts's ReactionAddedConfig
}

const reactionRemovedConfig: z.ZodType<ReactionRemovedConfig> = z.object({
  channel_id: z.string().optional(),
});

export const reactionRemoved: TriggerDefinition<unknown, ReactionRemovedEvent, ReactionRemovedConfig> = {
  key: "reaction_removed",
  description:
    "Fires when someone removes an emoji reaction from a message in a channel the connected app can see. Pass config.channel_id to scope to one channel.",
  mode: "webhook",
  payload: reactionRemovedPayload,
  config: reactionRemovedConfig,
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

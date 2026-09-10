// API reference: https://docs.slack.dev/reference/events/message (Events API `message` event) — the
// SlackMessageEventPayload shape below is that doc's payload, trimmed to the fields we use.
//
// Real trigger — webhook mode, per the DECIDED note this file used to carry (verified unanimous across
// Composio/Pipedream/n8n's real source/docs, not guessed). This file only parses ONE already-extracted
// Slack event into our normalized shape; the harder parts — figuring out WHICH connection an inbound
// event belongs to (Slack sends one Events API POST per app-level subscription, not per our
// TriggerInstance), the url_verification handshake, and signature verification — live in
// src/api/webhook_routes.ts's /webhooks/slack/events handler and src/lib/slackSignature.ts, since those
// are concerns about the inbound HTTP request itself, not about one specific trigger's payload shape.

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";

export interface NewMessageEvent {
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string; // present when this message is a reply within a thread
}

const newMessagePayload: z.ZodType<NewMessageEvent> = z.object({
  channel: z.string(),
  user: z.string(),
  text: z.string(),
  ts: z.string(),
  thread_ts: z.string().optional(),
});

// Raw shape of a Slack `message` event, per https://api.slack.com/events/message — only the fields we
// actually use, not the full (much larger) real shape.
export interface SlackMessageEventPayload {
  type: string; // "message"
  subtype?: string; // e.g. "bot_message" — filtered out by webhook_routes.ts before this is even called
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string; // set by Slack when this message is a reply within a thread
  bot_id?: string;
}

export interface NewMessageConfig {
  channel_id?: string; // scope to one real channel ID, e.g. "C0772SYKNN4" (from list_channels) — NOT a
  // "#name": matchesConfig below only does a plain equality check against Slack's raw event.channel (always
  // an ID), so a name here would just silently never match, no error, unlike an action's channel_id
  // rejecting a bad value with a real Slack API error.
  thread_ts?: string; // scope to one thread within that channel (a message's own `ts` once it has replies)
}

const newMessageConfig: z.ZodType<NewMessageConfig> = z.object({
  channel_id: z.string().optional(),
  thread_ts: z.string().optional(),
});

// `unknown`, not `never`, for the Cursor type param — this trigger doesn't use a cursor (webhook mode),
// but `never` there trips the same any/unknown variance issue types.ts's AppDefinition.triggers TODO
// already documents for actions.
export const newMessage: TriggerDefinition<unknown, NewMessageEvent, NewMessageConfig> = {
  key: "new_message",
  description:
    "Fires when a new message is posted in a channel the connected app can see. Pass config.channel_id to scope to one channel, and/or config.thread_ts to scope to one thread within it — omit both to fire for every channel.",
  mode: "webhook",
  payload: newMessagePayload,
  config: newMessageConfig,
  matchesConfig(rawPayload, config) {
    const event = rawPayload as SlackMessageEventPayload;
    if (config.channel_id && event.channel !== config.channel_id) return false;
    if (config.thread_ts && event.thread_ts !== config.thread_ts) return false;
    return true;
  },
  async handleWebhook(_connection, rawPayload) {
    const event = rawPayload as SlackMessageEventPayload;
    return [
      {
        channel: event.channel,
        user: event.user ?? "",
        text: event.text ?? "",
        ts: event.ts,
        thread_ts: event.thread_ts,
      },
    ];
  },
};

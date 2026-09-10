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
}

const newMessagePayload: z.ZodType<NewMessageEvent> = z.object({
  channel: z.string(),
  user: z.string(),
  text: z.string(),
  ts: z.string(),
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
  bot_id?: string;
}

// `unknown`, not `never`, for the Cursor type param — this trigger doesn't use a cursor (webhook mode),
// but `never` there trips the same any/unknown variance issue types.ts's AppDefinition.triggers TODO
// already documents for actions.
export const newMessage: TriggerDefinition<unknown, NewMessageEvent> = {
  key: "new_message",
  description: "Fires when a new message is posted in a channel the connected app can see.",
  mode: "webhook",
  payload: newMessagePayload,
  // TODO(ask): still open — does a trigger *instance* need a specific channel_id at subscribe-time, or
  // does this fire for all channels the app is in? Currently: all channels (no per-instance filter yet).
  async handleWebhook(_connection, rawPayload) {
    const event = rawPayload as SlackMessageEventPayload;
    return [
      {
        channel: event.channel,
        user: event.user ?? "",
        text: event.text ?? "",
        ts: event.ts,
      },
    ];
  },
};

// API reference: https://docs.slack.dev/reference/events/message.message_changed — a `message` event
// with subtype "message_changed", NOT a separate top-level event type. webhook_routes.ts's dispatcher
// routes on (type, subtype) together to land here instead of newMessage.ts.

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";

export interface MessageEditedEvent {
  channel: string;
  user: string;
  text: string;
  ts: string; // the edited message's own ts (message.ts), not the wrapper event's ts
  previous_text: string;
  thread_ts?: string;
}

const messageEditedPayload: z.ZodType<MessageEditedEvent> = z.object({
  channel: z.string(),
  user: z.string(),
  text: z.string(),
  ts: z.string(),
  previous_text: z.string(),
  thread_ts: z.string().optional(),
});

// Raw shape of a Slack `message_changed` sub-event, per https://api.slack.com/events/message.message_changed
export interface SlackMessageChangedEventPayload {
  type: string; // "message"
  subtype: "message_changed";
  channel: string;
  hidden?: boolean;
  ts: string; // wrapper event ts, not the message's own ts
  message?: { text?: string; user?: string; ts?: string; thread_ts?: string; bot_id?: string };
  previous_message?: { text?: string };
}

export interface MessageEditedConfig {
  channel_id?: string; // real channel ID, NOT a "#name" — see newMessage.ts's NewMessageConfig comment
  thread_ts?: string;
}

const messageEditedConfig: z.ZodType<MessageEditedConfig> = z.object({
  channel_id: z.string().optional(),
  thread_ts: z.string().optional(),
});

export const messageEdited: TriggerDefinition<unknown, MessageEditedEvent, MessageEditedConfig> = {
  key: "message_edited",
  description:
    "Fires when a message is edited in a channel the connected app can see. Pass config.channel_id to scope to one channel, and/or config.thread_ts to scope to one thread within it.",
  mode: "webhook",
  payload: messageEditedPayload,
  config: messageEditedConfig,
  matchesConfig(rawPayload, config) {
    const event = rawPayload as SlackMessageChangedEventPayload;
    if (config.channel_id && event.channel !== config.channel_id) return false;
    if (config.thread_ts && event.message?.thread_ts !== config.thread_ts) return false;
    return true;
  },
  async handleWebhook(_connection, rawPayload) {
    const event = rawPayload as SlackMessageChangedEventPayload;
    return [
      {
        channel: event.channel,
        user: event.message?.user ?? "",
        text: event.message?.text ?? "",
        ts: event.message?.ts ?? event.ts,
        previous_text: event.previous_message?.text ?? "",
        thread_ts: event.message?.thread_ts,
      },
    ];
  },
};

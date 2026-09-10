// API reference: https://docs.slack.dev/reference/events/message.message_deleted — a `message` event
// with subtype "message_deleted", NOT a separate top-level event type.

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";

export interface MessageDeletedEvent {
  channel: string;
  ts: string; // the deleted message's own ts
  previous_text: string;
  previous_user: string;
  thread_ts?: string;
}

const messageDeletedPayload: z.ZodType<MessageDeletedEvent> = z.object({
  channel: z.string(),
  ts: z.string(),
  previous_text: z.string(),
  previous_user: z.string(),
  thread_ts: z.string().optional(),
});

// Raw shape of a Slack `message_deleted` sub-event, per https://api.slack.com/events/message.message_deleted
export interface SlackMessageDeletedEventPayload {
  type: string; // "message"
  subtype: "message_deleted";
  channel: string;
  hidden?: boolean;
  ts: string; // wrapper event ts
  deleted_ts?: string; // the ts of the message that was deleted
  previous_message?: { text?: string; user?: string; ts?: string; thread_ts?: string };
}

export interface MessageDeletedConfig {
  channel_id?: string; // real channel ID, NOT a "#name" — see newMessage.ts's NewMessageConfig comment
  thread_ts?: string;
}

const messageDeletedConfig: z.ZodType<MessageDeletedConfig> = z.object({
  channel_id: z.string().optional(),
  thread_ts: z.string().optional(),
});

export const messageDeleted: TriggerDefinition<unknown, MessageDeletedEvent, MessageDeletedConfig> = {
  key: "message_deleted",
  description:
    "Fires when a message is deleted from a channel the connected app can see. Pass config.channel_id to scope to one channel, and/or config.thread_ts to scope to one thread within it.",
  mode: "webhook",
  payload: messageDeletedPayload,
  config: messageDeletedConfig,
  matchesConfig(rawPayload, config) {
    const event = rawPayload as SlackMessageDeletedEventPayload;
    if (config.channel_id && event.channel !== config.channel_id) return false;
    if (config.thread_ts && event.previous_message?.thread_ts !== config.thread_ts) return false;
    return true;
  },
  async handleWebhook(_connection, rawPayload) {
    const event = rawPayload as SlackMessageDeletedEventPayload;
    return [
      {
        channel: event.channel,
        ts: event.deleted_ts ?? event.previous_message?.ts ?? event.ts,
        previous_text: event.previous_message?.text ?? "",
        previous_user: event.previous_message?.user ?? "",
        thread_ts: event.previous_message?.thread_ts,
      },
    ];
  },
};

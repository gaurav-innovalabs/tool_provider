// API reference: https://docs.slack.dev/reference/events/file_shared (bot scope: files:read). Slack
// trimmed this event's payload down years ago to avoid file-object bloat — the modern shape only carries
// IDs (file_id, channel_id, user_id), not the file's name/title/size/url; call files.info with file_id if
// you need those (no files.info action exists in this app yet — add one if this trigger needs it).

import { z } from "zod";
import type { TriggerDefinition } from "../../../types";

export interface FileSharedEvent {
  file_id: string;
  channel_id: string;
  user_id: string;
  ts: string; // event_ts
}

const fileSharedPayload: z.ZodType<FileSharedEvent> = z.object({
  file_id: z.string(),
  channel_id: z.string(),
  user_id: z.string(),
  ts: z.string(),
});

// Raw shape of a Slack `file_shared` event, per https://api.slack.com/events/file_shared
export interface SlackFileSharedEventPayload {
  type: string; // "file_shared"
  channel_id: string;
  file_id: string;
  user_id: string;
  file?: { id: string };
  event_ts: string;
}

export interface FileSharedConfig {
  channel_id?: string; // real channel ID, NOT a "#name" — see newMessage.ts's NewMessageConfig comment
}

const fileSharedConfig: z.ZodType<FileSharedConfig> = z.object({
  channel_id: z.string().optional(),
});

export const fileShared: TriggerDefinition<unknown, FileSharedEvent, FileSharedConfig> = {
  key: "file_shared",
  description: "Fires when a file is shared in a channel the connected app can see. Pass config.channel_id to scope to one channel.",
  mode: "webhook",
  payload: fileSharedPayload,
  config: fileSharedConfig,
  matchesConfig(rawPayload, config) {
    const event = rawPayload as SlackFileSharedEventPayload;
    if (config.channel_id && event.channel_id !== config.channel_id) return false;
    return true;
  },
  async handleWebhook(_connection, rawPayload) {
    const event = rawPayload as SlackFileSharedEventPayload;
    return [
      {
        file_id: event.file_id,
        channel_id: event.channel_id,
        user_id: event.user_id,
        ts: event.event_ts,
      },
    ];
  },
};

// Phase 3.
//
// TODO(ask) — this is the one place Slack genuinely diverges from Gmail: Slack has a native push
// mechanism (Events API — Slack calls a webhook URL you register, e.g. `message.channels` event) that
// Gmail doesn't have without the whole Pub/Sub subsystem. Two options:
//   (a) mode: "webhook" now, using Slack's Events API directly (less code overall than Gmail's poll path,
//       since Slack pushes full event payloads, no `history.list`-equivalent second call needed) — but
//       this means Phase 3's trigger engine needs to support BOTH poll and webhook modes from day one,
//       not poll-only-then-add-webhook-later like Gmail.
//   (b) mode: "poll" for consistency with Gmail's Phase 3 shape (conversations.history + a stored cursor),
//       deferring Slack's native webhook support to whenever Phase 6 (outbound delivery infra) exists,
//       since inbound Slack Events API webhook handling has its own concern (URL verification handshake,
//       signing secret) that's arguably a Phase 6-shaped problem, not Phase 3.
// Currently stubbed as "poll" below to match Gmail's shape and keep Phase 3 single-mode; flip to "webhook"
// + implement handleWebhook() instead if (a) is preferred.

import type { TriggerDefinition } from "../../../types";

export interface SlackPollCursor {
  oldest_ts: string;
}

export interface NewMessageEvent {
  channel: string;
  user: string;
  text: string;
  ts: string;
}

export const newMessage: TriggerDefinition<SlackPollCursor, NewMessageEvent> = {
  key: "new_message",
  description: "Fires when a new message is posted in a channel the connected app can see.",
  mode: "poll",
  async poll(_connection, _cursor) {
    // TODO: conversations.history per subscribed channel, filtered by oldest=cursor.oldest_ts.
    // TODO(ask): does a trigger *instance* need a specific channel_id at subscribe-time, or does this fire
    // for all channels the app is in? (Gmail's newEmail has no such "which mailbox" ambiguity — Slack does.)
    throw new Error("not implemented");
  },
};

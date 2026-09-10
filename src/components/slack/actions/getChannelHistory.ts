// API reference: https://docs.slack.dev/reference/methods/conversations.history (bot scope: channels:history)
// Response shape: { ok, messages: [{ ts, user, text, thread_ts?, reply_count? }], has_more,
//   response_metadata: { next_cursor } } — pagination not wired up, same simplification as
// list_channels/list_users; `limit` just caps the one page of most-recent messages.
//
// Distinct from find_messages: that one is a real SEARCH (search.messages, requires the user token and
// search:read scope, ranked by relevance); this is a plain "show me the last N messages" channel read,
// works off the bot token like every other read action in this app.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  channel: z.string().describe("Channel id, e.g. from list_channels"),
  limit: z.number().int().min(1).max(200).default(20),
});

const messageSummary = z.object({
  ts: z.string(),
  user: z.string().optional(),
  text: z.string(),
  thread_ts: z.string().optional(),
  reply_count: z.number().optional(),
});

const output = z.array(messageSummary);

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackConversationsHistoryResponse {
  ok: boolean;
  error?: string;
  messages?: { ts: string; user?: string; text?: string; thread_ts?: string; reply_count?: number }[];
}

export const getChannelHistory: ActionDefinition<Input, Output> = {
  key: "get_channel_history",
  description:
    "Read the most recent messages posted in a Slack channel — a plain channel read, distinct from find_messages (which searches and needs the user token).",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const url = new URL("https://slack.com/api/conversations.history");
    url.searchParams.set("channel", params.channel);
    url.searchParams.set("limit", String(params.limit));

    const res = await fetch(url, { headers: { Authorization: `Bearer ${connection.secrets.access_token}` } });
    const data = (await res.json()) as SlackConversationsHistoryResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack get_channel_history failed: ${data.error ?? res.statusText}`);
    }
    return (data.messages ?? []).map((m) => ({ ts: m.ts, user: m.user, text: m.text ?? "", thread_ts: m.thread_ts, reply_count: m.reply_count }));
  },
};

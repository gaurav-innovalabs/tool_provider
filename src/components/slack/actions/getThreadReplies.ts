// API reference: https://docs.slack.dev/reference/methods/conversations.replies (bot scope: channels:history
// — same scope as get_channel_history, Slack doesn't split threads into a separate scope). Response shape
// mirrors conversations.history's messages array, with the parent message as the first element.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  channel: z.string().describe("Channel id the thread lives in"),
  thread_ts: z.string().describe("The parent message's ts — from get_channel_history, find_messages, or post_message's result"),
  limit: z.number().int().min(1).max(200).default(50),
});

const replySummary = z.object({
  ts: z.string(),
  user: z.string().optional(),
  text: z.string(),
});

const output = z.array(replySummary);

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackConversationsRepliesResponse {
  ok: boolean;
  error?: string;
  messages?: { ts: string; user?: string; text?: string }[];
}

export const getThreadReplies: ActionDefinition<Input, Output> = {
  key: "get_thread_replies",
  description: "Read all replies in a Slack thread — the first item in the result is the parent message itself.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const url = new URL("https://slack.com/api/conversations.replies");
    url.searchParams.set("channel", params.channel);
    url.searchParams.set("ts", params.thread_ts);
    url.searchParams.set("limit", String(params.limit));

    const res = await fetch(url, { headers: { Authorization: `Bearer ${connection.secrets.access_token}` } });
    const data = (await res.json()) as SlackConversationsRepliesResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack get_thread_replies failed: ${data.error ?? res.statusText}`);
    }
    return (data.messages ?? []).map((m) => ({ ts: m.ts, user: m.user, text: m.text ?? "" }));
  },
};

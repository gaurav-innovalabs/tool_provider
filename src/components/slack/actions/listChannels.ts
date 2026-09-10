// API reference: https://docs.slack.dev/reference/methods/conversations.list (bot scope: channels:read)
// Response shape: { ok, channels: [{ id, name, is_member, ... }], response_metadata: { next_cursor } } —
// we only surface id/name/is_member; pagination (next_cursor) isn't wired up, `limit` caps the one page.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeSlackError } from "../../../lib/slackErrors";

const input = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});

const channelSummary = z.object({
  id: z.string(),
  name: z.string(),
  is_member: z.boolean(),
});

const output = z.array(channelSummary);

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackConversationsListResponse {
  ok: boolean;
  error?: string;
  channels?: { id: string; name: string; is_member: boolean }[];
}

export const listChannels: ActionDefinition<Input, Output> = {
  key: "list_channels",
  description: "List channels visible to the connected Slack workspace app.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const url = new URL("https://slack.com/api/conversations.list");
    url.searchParams.set("limit", String(params.limit));

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${connection.secrets!.access_token}` },
    });

    const data = (await res.json()) as SlackConversationsListResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack list_channels failed: ${describeSlackError(data.error ?? res.statusText)}`);
    }

    return (data.channels ?? []).map((c) => ({ id: c.id, name: c.name, is_member: c.is_member }));
  },
};

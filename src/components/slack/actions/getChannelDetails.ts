// API reference: https://docs.slack.dev/reference/methods/conversations.info (bot scope: channels:read,
// already granted — no new scope needed).

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  channel: z.string().describe("Channel id, e.g. from list_channels"),
});

const output = z.object({
  id: z.string(),
  name: z.string(),
  is_member: z.boolean(),
  is_archived: z.boolean(),
  topic: z.string().optional(),
  purpose: z.string().optional(),
  num_members: z.number().optional(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackConversationsInfoResponse {
  ok: boolean;
  error?: string;
  channel?: {
    id: string;
    name: string;
    is_member: boolean;
    is_archived: boolean;
    topic?: { value?: string };
    purpose?: { value?: string };
    num_members?: number;
  };
}

export const getChannelDetails: ActionDefinition<Input, Output> = {
  key: "get_channel_details",
  description: "Get details about a single Slack channel — name, membership, archive state, topic/purpose.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const url = new URL("https://slack.com/api/conversations.info");
    url.searchParams.set("channel", params.channel);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${connection.secrets.access_token}` } });
    const data = (await res.json()) as SlackConversationsInfoResponse;
    if (!res.ok || !data.ok || !data.channel) {
      throw new Error(`Slack get_channel_details failed: ${data.error ?? res.statusText}`);
    }
    return {
      id: data.channel.id,
      name: data.channel.name,
      is_member: data.channel.is_member,
      is_archived: data.channel.is_archived,
      topic: data.channel.topic?.value,
      purpose: data.channel.purpose?.value,
      num_members: data.channel.num_members,
    };
  },
};

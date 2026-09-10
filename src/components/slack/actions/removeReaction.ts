// API reference: https://docs.slack.dev/reference/methods/reactions.remove (bot scope: reactions:write)
// Response shape: { ok } on success. Same `timestamp`-not-`ts` wire param as reactions.add — see that file.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeSlackError } from "../../../lib/slackErrors";

const input = z.object({
  // reactions.remove requires the real channel ID — same "no #name resolution" rule as add_reaction.
  channel_id: z.string().min(1).describe("Channel ID, e.g. from list_channels — NOT a #channel-name"),
  ts: z.string().min(1),
  name: z.string().min(1),
});

const output = z.object({ ok: z.boolean() });

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

export const removeReaction: ActionDefinition<Input, Output> = {
  key: "remove_reaction",
  description: "Remove an emoji reaction from a Slack message.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch("https://slack.com/api/reactions.remove", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets!.access_token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: params.channel_id, timestamp: params.ts, name: params.name }),
    });

    const data = (await res.json()) as SlackApiResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack remove_reaction failed: ${describeSlackError(data.error ?? res.statusText)}`);
    }

    return { ok: true };
  },
};

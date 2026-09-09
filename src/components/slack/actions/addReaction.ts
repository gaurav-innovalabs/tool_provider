// API reference: https://docs.slack.dev/reference/methods/reactions.add (bot scope: reactions:write)
// Response shape: { ok } on success, { ok: false, error } on failure (e.g. "already_reacted"). Note the
// wire param is `timestamp`, not `ts` — chat.* methods use `ts`, reactions.* methods use `timestamp`;
// that's a real Slack API inconsistency, not a typo here.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  channel: z.string().min(1),
  ts: z.string().min(1),
  name: z.string().min(1), // emoji name without colons, e.g. "thumbsup"
});

const output = z.object({ ok: z.boolean() });

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

export const addReaction: ActionDefinition<Input, Output> = {
  key: "add_reaction",
  description: "Add an emoji reaction to a Slack message.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets!.access_token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: params.channel, timestamp: params.ts, name: params.name }),
    });

    const data = (await res.json()) as SlackApiResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack add_reaction failed: ${data.error ?? res.statusText}`);
    }

    return { ok: true };
  },
};

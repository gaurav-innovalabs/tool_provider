// API reference: https://docs.slack.dev/reference/methods/conversations.create — bot scope: one of
// channels:manage / channels:write / groups:write depending on is_private, per that doc; this app only
// declares channels:manage (see app.ts), so is_private: true will fail with missing_scope until this app's
// scope list grows groups:write too.
// Response shape: { ok, channel: { id, name, ... } } on success.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeSlackError } from "../../../lib/slackErrors";

const input = z.object({
  name: z.string().min(1), // lowercase, no spaces — Slack normalizes/validates server-side
  is_private: z.boolean().default(false),
});

const output = z.object({
  id: z.string(),
  name: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  channel?: { id: string; name: string };
}

export const createChannel: ActionDefinition<Input, Output> = {
  key: "create_channel",
  description: "Create a new Slack channel, public or private.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch("https://slack.com/api/conversations.create", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets!.access_token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ name: params.name, is_private: params.is_private }),
    });

    const data = (await res.json()) as SlackApiResponse;
    if (!res.ok || !data.ok || !data.channel) {
      throw new Error(`Slack create_channel failed: ${describeSlackError(data.error ?? res.statusText)}`);
    }

    return { id: data.channel.id, name: data.channel.name };
  },
};

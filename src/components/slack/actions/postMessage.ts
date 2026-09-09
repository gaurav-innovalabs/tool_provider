// No @slack/web-api dependency — Slack's Web API is plain JSON-over-HTTP, `fetch` is enough.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  channel: z.string().min(1), // channel id or name
  text: z.string().min(1),
});

const output = z.object({
  ts: z.string(), // Slack message timestamp, used as its id
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
}

export const postMessage: ActionDefinition<Input, Output> = {
  key: "post_message",
  description: "Post a message to a Slack channel using the connected workspace.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets!.access_token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: params.channel, text: params.text }),
    });

    // Slack's Web API returns HTTP 200 even on failure — real errors are in the JSON `ok`/`error` fields,
    // not the status code. Must check both.
    const data = (await res.json()) as SlackApiResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack post_message failed: ${data.error ?? res.statusText}`);
    }

    return { ts: data.ts! };
  },
};

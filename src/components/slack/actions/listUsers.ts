// API reference: https://docs.slack.dev/reference/methods/users.list (bot scope: users:read)
// Response shape: { ok, members: [{ id, name, real_name, is_bot, ... }], response_metadata: { next_cursor } }
// — pagination isn't wired up, `limit` caps the one page, same simplification as list_channels.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});

const userSummary = z.object({
  id: z.string(),
  name: z.string(),
  real_name: z.string().optional(),
  is_bot: z.boolean(),
});

const output = z.array(userSummary);

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackUsersListResponse {
  ok: boolean;
  error?: string;
  members?: { id: string; name: string; real_name?: string; is_bot: boolean }[];
}

export const listUsers: ActionDefinition<Input, Output> = {
  key: "list_users",
  description: "List members of the connected Slack workspace.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const url = new URL("https://slack.com/api/users.list");
    url.searchParams.set("limit", String(params.limit));

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${connection.secrets!.access_token}` },
    });

    const data = (await res.json()) as SlackUsersListResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack list_users failed: ${data.error ?? res.statusText}`);
    }

    return (data.members ?? []).map((m) => ({ id: m.id, name: m.name, real_name: m.real_name, is_bot: m.is_bot }));
  },
};

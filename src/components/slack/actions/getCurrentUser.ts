// API reference: https://docs.slack.dev/reference/methods/auth.test — no extra scope required, works with
// whatever token the connection already has. Cheap "who/what am I connected as" sanity check, same role
// Gmail's get_current_user plays.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({});

const output = z.object({
  user_id: z.string(),
  user: z.string(),
  team_id: z.string(),
  team: z.string(),
  bot_id: z.string().optional(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackAuthTestResponse {
  ok: boolean;
  error?: string;
  user_id?: string;
  user?: string;
  team_id?: string;
  team?: string;
  bot_id?: string;
}

export const getCurrentUser: ActionDefinition<Input, Output> = {
  key: "get_current_user",
  description: "Identify the Slack workspace/bot this connection is authenticated as — a cheap sanity check before calling other actions.",
  input,
  output,
  async run(connection) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${connection.secrets.access_token}` },
    });
    const data = (await res.json()) as SlackAuthTestResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack get_current_user failed: ${data.error ?? res.statusText}`);
    }
    return { user_id: data.user_id ?? "", user: data.user ?? "", team_id: data.team_id ?? "", team: data.team ?? "", bot_id: data.bot_id };
  },
};

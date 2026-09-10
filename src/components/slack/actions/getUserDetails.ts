// API reference: https://docs.slack.dev/reference/methods/users.info (bot scope: users:read, already
// granted — note `profile.email` is only populated if users:read.email is also granted, which it is).

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  user: z.string().describe("Slack user id, e.g. from list_users or find_user_by_email"),
});

const output = z.object({
  id: z.string(),
  name: z.string(),
  real_name: z.string().optional(),
  email: z.string().optional(),
  is_bot: z.boolean(),
  is_admin: z.boolean().optional(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackUsersInfoResponse {
  ok: boolean;
  error?: string;
  user?: {
    id: string;
    name: string;
    real_name?: string;
    is_bot: boolean;
    is_admin?: boolean;
    profile?: { email?: string };
  };
}

export const getUserDetails: ActionDefinition<Input, Output> = {
  key: "get_user_details",
  description: "Get details about a single Slack user — name, email (if visible), bot/admin flags.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const url = new URL("https://slack.com/api/users.info");
    url.searchParams.set("user", params.user);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${connection.secrets.access_token}` } });
    const data = (await res.json()) as SlackUsersInfoResponse;
    if (!res.ok || !data.ok || !data.user) {
      throw new Error(`Slack get_user_details failed: ${data.error ?? res.statusText}`);
    }
    return {
      id: data.user.id,
      name: data.user.name,
      real_name: data.user.real_name,
      email: data.user.profile?.email,
      is_bot: data.user.is_bot,
      is_admin: data.user.is_admin,
    };
  },
};

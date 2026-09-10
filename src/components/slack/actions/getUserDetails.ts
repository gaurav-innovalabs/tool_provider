// API reference: https://docs.slack.dev/reference/methods/users.info (bot scope: users:read, already
// granted — note `profile.email` is only populated if users:read.email is also granted, which it is).

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeSlackError } from "../../../lib/slackErrors";

const input = z.object({
  user: z.string().describe("Slack user id, e.g. from list_users or find_user_by_email"),
});

const output = z.object({
  id: z.string(),
  name: z.string(),
  real_name: z.string().optional(),
  email: z.string().optional(),
  // The actual "active or not" flag — Slack calls it `deleted`, true for a deactivated/deleted account.
  // There's no separate "is_active" field on Slack's side; `!deleted` IS "active".
  deleted: z.boolean(),
  is_bot: z.boolean(),
  is_admin: z.boolean().optional(),
  is_owner: z.boolean().optional(),
  is_restricted: z.boolean().optional(), // guest account (single-channel or multi-channel)
  is_ultra_restricted: z.boolean().optional(), // single-channel guest specifically
  tz: z.string().optional(), // IANA timezone, e.g. "Asia/Kolkata"
  avatar_url: z.string().optional(),
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
    deleted: boolean;
    is_bot: boolean;
    is_admin?: boolean;
    is_owner?: boolean;
    is_restricted?: boolean;
    is_ultra_restricted?: boolean;
    tz?: string;
    profile?: { email?: string; image_192?: string };
  };
}

export const getUserDetails: ActionDefinition<Input, Output> = {
  key: "get_user_details",
  description: "Get details about a single Slack user — name, email (if visible), active/deleted status, bot/admin/owner/guest flags.",
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
      throw new Error(`Slack get_user_details failed: ${describeSlackError(data.error ?? res.statusText)}`);
    }
    return {
      id: data.user.id,
      name: data.user.name,
      real_name: data.user.real_name,
      email: data.user.profile?.email,
      deleted: data.user.deleted,
      is_bot: data.user.is_bot,
      is_admin: data.user.is_admin,
      is_owner: data.user.is_owner,
      is_restricted: data.user.is_restricted,
      is_ultra_restricted: data.user.is_ultra_restricted,
      tz: data.user.tz,
      avatar_url: data.user.profile?.image_192,
    };
  },
};

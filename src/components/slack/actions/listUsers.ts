// API reference: https://docs.slack.dev/reference/methods/users.list (bot scope: users:read; `profile.email`
// additionally needs users:read.email, already granted — see app.ts's scopes).
// Response shape: { ok, members: [{ id, name, real_name, deleted, is_bot, is_admin, is_owner, is_restricted,
// is_ultra_restricted, tz, profile: { email, image_192 }, ... }], response_metadata: { next_cursor } } —
// pagination isn't wired up, `limit` caps the one page, same simplification as list_channels. Previously
// this action only surfaced id/name/real_name/is_bot — critically DROPPING Slack's own `deleted` field,
// so a caller had no way to tell an active member from a deactivated one (every member looked identical);
// fixed here to mirror get_user_details' richer shape instead of a stripped-down summary.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeSlackError } from "../../../lib/slackErrors";

const input = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});

const userSummary = z.object({
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

const output = z.array(userSummary);

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackUserRecord {
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
}

interface SlackUsersListResponse {
  ok: boolean;
  error?: string;
  members?: SlackUserRecord[];
}

export const listUsers: ActionDefinition<Input, Output> = {
  key: "list_users",
  description: "List members of the connected Slack workspace, including deactivated ones (check `deleted`) and guest/admin/owner status.",
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
      throw new Error(`Slack list_users failed: ${describeSlackError(data.error ?? res.statusText)}`);
    }

    return (data.members ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      real_name: m.real_name,
      email: m.profile?.email,
      deleted: m.deleted,
      is_bot: m.is_bot,
      is_admin: m.is_admin,
      is_owner: m.is_owner,
      is_restricted: m.is_restricted,
      is_ultra_restricted: m.is_ultra_restricted,
      tz: m.tz,
      avatar_url: m.profile?.image_192,
    }));
  },
};

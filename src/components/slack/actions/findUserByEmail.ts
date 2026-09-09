// API reference: https://docs.slack.dev/reference/methods/users.lookupByEmail
// (bot scope: users:read.email — note this is separate from users:read; users.list works with only
// users:read, this endpoint additionally needs the email-specific scope)
// Response shape: { ok, user: { id, name, real_name, ... } } on success, { ok: false, error: "users_not_found" }
// when no match.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  email: z.string().email(),
});

const output = z.object({
  id: z.string(),
  name: z.string(),
  real_name: z.string().optional(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackUsersLookupResponse {
  ok: boolean;
  error?: string;
  user?: { id: string; name: string; real_name?: string };
}

export const findUserByEmail: ActionDefinition<Input, Output> = {
  key: "find_user_by_email",
  description: "Look up a Slack user by their email address.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const url = new URL("https://slack.com/api/users.lookupByEmail");
    url.searchParams.set("email", params.email);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${connection.secrets!.access_token}` },
    });

    const data = (await res.json()) as SlackUsersLookupResponse;
    if (!res.ok || !data.ok || !data.user) {
      throw new Error(`Slack find_user_by_email failed: ${data.error ?? res.statusText}`);
    }

    return { id: data.user.id, name: data.user.name, real_name: data.user.real_name };
  },
};

// API reference: https://developers.google.com/gmail/api/reference/rest/v1/users/getProfile
// (scope: gmail.readonly, already granted) — cheap "who am I connected as" sanity check, same role
// Slack's get_current_user (auth.test) plays.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z.object({});

const output = z.object({
  email_address: z.string(),
  messages_total: z.number(),
  threads_total: z.number(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface GmailProfileResponse {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
}

export const getCurrentUser: ActionDefinition<Input, Output> = {
  key: "get_current_user",
  description: "Identify the Gmail account this connection is authenticated as, plus mailbox size — a cheap sanity check before calling other actions.",
  input,
  output,
  async run(connection) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${connection.secrets.access_token}` },
    });
    if (!res.ok) {
      throw new Error(`Gmail get_current_user failed (${res.status}): ${await describeGoogleApiError(res)}`);
    }
    const data = (await res.json()) as GmailProfileResponse;
    return { email_address: data.emailAddress, messages_total: data.messagesTotal, threads_total: data.threadsTotal };
  },
};

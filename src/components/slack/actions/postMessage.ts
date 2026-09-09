// API reference: https://docs.slack.dev/reference/methods/chat.postMessage (bot scope: chat:write)
// Response shape verified against that doc: { ok, channel, ts, message: {...} } on success,
// { ok: false, error } on failure — we only need channel/ts, message is discarded.
// Approach: no @slack/web-api dependency — Slack's Web API is plain JSON-over-HTTP, `fetch` is enough.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  channel: z.string().min(1), // channel id or name
  text: z.string().min(1), // required even with blocks — Slack uses it as the notification/fallback text
  // Raw Slack Block Kit blocks — passed straight through, un-validated (Slack's own schema is huge and this
  // project isn't in the business of re-implementing it). z.unknown()'s array, not a typed block union.
  blocks: z.array(z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(),
  // false (default) = post as the bot, using the bot token (secrets.access_token) — this is what every
  // caller gets unless they opt in. true = post as the human who authorized the connection, using their
  // user token (secrets.user_access_token, only present if the OAuth grant included the `user_scope`
  // request — see app.ts's extraAuthorizeParams). NOT Slack's old `as_user` chat.postMessage param (that
  // only affects classic apps); this is "which token do we call the API with".
  as_user: z.boolean().default(false),
  // Bot-identity customization — chat.postMessage ignores these when as_user is true (a message posted
  // with a user token is always attributed to that user, it can't be renamed/re-iconed).
  username: z.string().optional(),
  icon_emoji: z.string().optional(), // e.g. ":robot_face:"
  icon_url: z.string().url().optional(),
});

const output = z.object({
  ts: z.string(), // Slack message timestamp, used as its id
  channel: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

export const postMessage: ActionDefinition<Input, Output> = {
  key: "post_message",
  description:
    "Post a message to a Slack channel using the connected workspace. Posts as the bot by default; set as_user to post as the authorizing user instead. Supports Block Kit via blocks/attachments.",
  input,
  output,
  async run(connection, params) {
    const token = params.as_user ? connection.secrets?.user_access_token : connection.secrets?.access_token;
    if (!token) {
      throw new Error(
        params.as_user
          ? `Connection ${connection.connection_id} has no user_access_token in secrets — reconnect Slack with the search:read/chat:write user scopes granted (declined "Act as you" during OAuth?).`
          : `Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`,
      );
    }

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: params.channel,
        text: params.text,
        blocks: params.blocks,
        attachments: params.attachments,
        // Slack silently ignores these three when the call is authenticated with a user token.
        username: params.as_user ? undefined : params.username,
        icon_emoji: params.as_user ? undefined : params.icon_emoji,
        icon_url: params.as_user ? undefined : params.icon_url,
      }),
    });

    // Slack's Web API returns HTTP 200 even on failure — real errors are in the JSON `ok`/`error` fields,
    // not the status code. Must check both.
    const data = (await res.json()) as SlackApiResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack post_message failed: ${data.error ?? res.statusText}`);
    }

    return { ts: data.ts!, channel: data.channel! };
  },
};

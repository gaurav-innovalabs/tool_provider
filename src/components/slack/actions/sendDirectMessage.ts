// API reference:
//   https://docs.slack.dev/reference/methods/conversations.open (bot scope: im:write)
//     response: { ok, channel: { id } } (also accepts a bare string id on some SDK docs' examples — we
//     handle both, see channelId extraction below)
//   https://docs.slack.dev/reference/methods/chat.postMessage (bot scope: chat:write) — see postMessage.ts
// Approach: Slack has no single "DM a user" endpoint — you open (or reuse) the IM conversation first via
// conversations.open, then post into it like any other channel. conversations.open is idempotent: calling
// it again for a user you already have a DM with just returns the existing channel id, no duplicate created.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  user: z.string().min(1), // Slack user id, e.g. "U0123456"
  text: z.string().min(1),
  blocks: z.array(z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(),
  // Same bot-vs-user token choice as post_message — see that file's comment. conversations.open also needs
  // to run with whichever token will send the message, since a DM opened by the bot and one opened by the
  // user are different channel ids.
  as_user: z.boolean().default(false),
  username: z.string().optional(),
  icon_emoji: z.string().optional(),
  icon_url: z.string().url().optional(),
});

const output = z.object({
  ts: z.string(),
  channel: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string | { id: string };
}

export const sendDirectMessage: ActionDefinition<Input, Output> = {
  key: "send_direct_message",
  description:
    "Send a direct message to a Slack user, opening the DM conversation if needed. Sends as the bot by default; set as_user to send as the authorizing user instead.",
  input,
  output,
  async run(connection, params) {
    const token = params.as_user ? connection.secrets?.user_access_token : connection.secrets?.access_token;
    if (!token) {
      throw new Error(
        params.as_user
          ? `Connection ${connection.connection_id} has no user_access_token in secrets — reconnect Slack with user scopes granted.`
          : `Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`,
      );
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    };

    const openRes = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers,
      body: JSON.stringify({ users: params.user }),
    });
    const openData = (await openRes.json()) as SlackApiResponse;
    if (!openRes.ok || !openData.ok) {
      throw new Error(`Slack send_direct_message (conversations.open) failed: ${openData.error ?? openRes.statusText}`);
    }
    const channelId = typeof openData.channel === "string" ? openData.channel : openData.channel?.id;
    if (!channelId) {
      throw new Error("Slack send_direct_message (conversations.open) returned no channel id");
    }

    const postRes = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers,
      body: JSON.stringify({
        channel: channelId,
        text: params.text,
        blocks: params.blocks,
        attachments: params.attachments,
        username: params.as_user ? undefined : params.username,
        icon_emoji: params.as_user ? undefined : params.icon_emoji,
        icon_url: params.as_user ? undefined : params.icon_url,
      }),
    });
    const postData = (await postRes.json()) as SlackApiResponse;
    if (!postRes.ok || !postData.ok) {
      throw new Error(`Slack send_direct_message (chat.postMessage) failed: ${postData.error ?? postRes.statusText}`);
    }

    return { ts: postData.ts!, channel: channelId };
  },
};

// API reference: https://docs.slack.dev/reference/methods/search.messages (USER scope: search:read — Slack
// docs are explicit this requires a user token, bot tokens are rejected with not_allowed_token_type).
// Response shape, verified against that doc:
//   { ok, query, messages: { matches: [{ ts, channel: { id, name, ... }, user, text, permalink, ... }],
//     pagination: { total_count, page, page_count, per_page } } }
// (pagination isn't wired up here — `count` caps the one page, same simplification as list_channels/list_users)
// Query syntax reference: https://slack.com/help/articles/202528808 — Slack folds channel/sender/date/tag
// filters straight into the query string itself (`in:#channel`, `from:@user`, `before:2026-01-01`,
// `after:2026-01-01`, `has:link`, `has:star`, etc.), so there's no separate structured filter object here,
// just `query`. The optional `channel` field is a convenience only: if given, it's appended as an `in:`
// term so callers don't have to know Slack's query syntax just to scope a search to one channel; anything
// else (dates, sender, tags, ...) the caller writes directly into `query`.
//
// This is the one action in this app with no bot-token fallback at all (unlike post/update/delete's
// as_user toggle) — see app.ts's extraAuthorizeParams for how the user token gets requested/captured.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeSlackError } from "../../../lib/slackErrors";

const input = z.object({
  // Free-form Slack search query — e.g. `hello from:@alice after:2026-01-01 has:link`.
  query: z.string().min(1),
  // Convenience only — folded into `query` as `in:<channel>`. Omit and just write `in:#general` yourself
  // in `query` if you prefer; both are equivalent.
  channel: z.string().optional(),
  sort: z.enum(["score", "timestamp"]).default("score"),
  count: z.number().int().min(1).max(100).default(20),
});

const messageResult = z.object({
  ts: z.string(),
  channel: z.string(),
  user: z.string().optional(),
  text: z.string(),
  permalink: z.string().optional(),
});

const output = z.array(messageResult);

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackSearchMessagesResponse {
  ok: boolean;
  error?: string;
  messages?: {
    matches?: {
      ts: string;
      channel?: { id?: string; name?: string };
      user?: string;
      text?: string;
      permalink?: string;
    }[];
  };
}

export const findMessages: ActionDefinition<Input, Output> = {
  key: "find_messages",
  description:
    "Search messages across the connected Slack workspace. query supports Slack's native search modifiers " +
    "(in:, from:, before:, after:, has:, etc.) — pass them all inline in query; channel is just a shorthand " +
    "for adding in:<channel>. Requires the connection's user token (as_user scopes), not just the bot token.",
  input,
  output,
  async run(connection, params) {
    const token = connection.secrets?.user_access_token;
    if (!token) {
      throw new Error(
        `Connection ${connection.connection_id} has no user_access_token in secrets — Slack's search.messages ` +
          `requires the authorizing user's token, not the bot token. Reconnect Slack and grant the user-level scopes.`,
      );
    }

    const query = params.channel ? `${params.query} in:${params.channel}` : params.query;

    const url = new URL("https://slack.com/api/search.messages");
    url.searchParams.set("query", query);
    url.searchParams.set("sort", params.sort);
    url.searchParams.set("count", String(params.count));

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = (await res.json()) as SlackSearchMessagesResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack find_messages failed: ${describeSlackError(data.error ?? res.statusText)}`);
    }

    return (data.messages?.matches ?? []).map((m) => ({
      ts: m.ts,
      channel: m.channel?.id ?? m.channel?.name ?? "",
      user: m.user,
      text: m.text ?? "",
      permalink: m.permalink,
    }));
  },
};

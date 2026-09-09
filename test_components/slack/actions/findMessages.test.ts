// Mocked body per https://docs.slack.dev/reference/methods/search.messages — see findMessages.ts's header
// (the `channel` field there is a nested object, { id, name, ... }, not a bare string — verified against
// the doc; findMessages.ts's mapping accounts for that).

import { describe, test, expect, afterEach } from "bun:test";
import { findMessages } from "../../../src/components/slack/actions/findMessages";
import { makeBotOnlyConnection, makeBotAndUserConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("findMessages", () => {
  test("requires the user token — throws before calling Slack when only a bot token is on the connection", async () => {
    mockSlackFetch([]); // no call should reach fetch at all

    await expect(runAction(findMessages, makeBotOnlyConnection(), { query: "hello" })).rejects.toThrow(
      /user_access_token/,
    );
  });

  test("maps search.messages matches to the declared output shape, using the user token", async () => {
    const { calls } = mockSlackFetch([
      {
        body: {
          ok: true,
          query: "hello",
          messages: {
            matches: [
              {
                type: "message",
                ts: "1508284197.000015",
                channel: { id: "C12345678", name: "general" },
                user: "U2U85N1RV",
                text: "hello there",
                permalink: "https://workspace.slack.com/archives/C12345678/p1508284197000015",
              },
            ],
            pagination: { total_count: 1, page: 1, page_count: 1, per_page: 20 },
          },
        },
      },
    ]);

    const result = await runAction(findMessages, makeBotAndUserConnection(), { query: "hello" });

    expect(result).toEqual([
      {
        ts: "1508284197.000015",
        channel: "C12345678",
        user: "U2U85N1RV",
        text: "hello there",
        permalink: "https://workspace.slack.com/archives/C12345678/p1508284197000015",
      },
    ]);
    expect(calls[0]!.headers.Authorization).toBe("Bearer xoxp-test-user-token");
  });

  test("folds the optional `channel` convenience field into the query as `in:<channel>`", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: true, query: "x", messages: { matches: [] } } }]);

    await runAction(findMessages, makeBotAndUserConnection(), { query: "deploy failed", channel: "#alerts" });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("query")).toBe("deploy failed in:#alerts");
  });

  test("surfaces not_allowed_token_type if a bot token somehow reaches Slack anyway", async () => {
    // Guards the doc-verified constraint itself, not just our pre-check: if secrets ever carried a bot
    // token under user_access_token by mistake, Slack's own rejection should still surface cleanly.
    mockSlackFetch([{ body: { ok: false, error: "not_allowed_token_type" } }]);

    await expect(runAction(findMessages, makeBotAndUserConnection(), { query: "hello" })).rejects.toThrow(
      /not_allowed_token_type/,
    );
  });
});

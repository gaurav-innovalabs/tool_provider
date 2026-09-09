// Mocked response bodies below are shaped per https://docs.slack.dev/reference/methods/chat.postMessage
// (see postMessage.ts's own header for the exact doc-verified fields) — not invented shapes.

import { describe, test, expect, afterEach } from "bun:test";
import { postMessage } from "../../../src/components/slack/actions/postMessage";
import { makeBotOnlyConnection, makeBotAndUserConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error — restoring after each mockSlackFetch install
  delete global.fetch;
});

describe("postMessage", () => {
  test("defaults to the bot token when as_user is omitted", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: true, channel: "C123ABC456", ts: "1503435956.000247" } }]);

    const result = await runAction(postMessage, makeBotOnlyConnection(), { channel: "C123ABC456", text: "hi" });

    expect(result).toEqual({ ts: "1503435956.000247", channel: "C123ABC456" });
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]!.headers.Authorization).toBe("Bearer xoxb-test-bot-token");
  });

  test("as_user: true posts with the user token instead", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: true, channel: "C123ABC456", ts: "1503435956.000247" } }]);

    await runAction(postMessage, makeBotAndUserConnection(), { channel: "C123ABC456", text: "hi", as_user: true });

    expect(calls[0]!.headers.Authorization).toBe("Bearer xoxp-test-user-token");
    // username/icon_* are bot-only cosmetics — must not be sent when posting as the user.
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.username).toBeUndefined();
  });

  test("as_user: true without a user_access_token in secrets throws before calling Slack", async () => {
    mockSlackFetch([]); // no call should reach fetch at all

    await expect(runAction(postMessage, makeBotOnlyConnection(), { channel: "C1", text: "hi", as_user: true })).rejects.toThrow(
      /user_access_token/,
    );
  });

  test("passes blocks/attachments through untouched", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: true, channel: "C1", ts: "123.456" } }]);
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*hi*" } }];

    await runAction(postMessage, makeBotOnlyConnection(), { channel: "C1", text: "hi", blocks });

    expect((calls[0]!.body as Record<string, unknown>).blocks).toEqual(blocks);
  });

  test("surfaces Slack's ok:false error even though the HTTP status is 200", async () => {
    // Per the docs: Slack's Web API returns HTTP 200 on failure too — the real signal is `ok: false`.
    mockSlackFetch([{ body: { ok: false, error: "channel_not_found" } }]);

    await expect(runAction(postMessage, makeBotOnlyConnection(), { channel: "C1", text: "hi" })).rejects.toThrow(
      /channel_not_found/,
    );
  });

  test("rejects input missing required text (schema reused from the action's own declaration)", () => {
    expect(() => postMessage.input.parse({ channel: "C1" })).toThrow();
  });
});

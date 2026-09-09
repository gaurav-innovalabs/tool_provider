// Mocked bodies per https://docs.slack.dev/reference/methods/conversations.open and
// https://docs.slack.dev/reference/methods/chat.postMessage — see sendDirectMessage.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { sendDirectMessage } from "../../../src/components/slack/actions/sendDirectMessage";
import { makeBotOnlyConnection, makeBotAndUserConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("sendDirectMessage", () => {
  test("opens the DM then posts into it, as the bot by default", async () => {
    const { calls } = mockSlackFetch([
      { body: { ok: true, channel: { id: "D0C0FFEE" } } }, // conversations.open
      { body: { ok: true, channel: "D0C0FFEE", ts: "111.222" } }, // chat.postMessage
    ]);

    const result = await runAction(sendDirectMessage, makeBotOnlyConnection(), { user: "U123", text: "hi" });

    expect(result).toEqual({ ts: "111.222", channel: "D0C0FFEE" });
    expect(calls[0]!.url).toBe("https://slack.com/api/conversations.open");
    expect((calls[0]!.body as Record<string, unknown>).users).toBe("U123");
    expect(calls[1]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect((calls[1]!.body as Record<string, unknown>).channel).toBe("D0C0FFEE");
    expect(calls[0]!.headers.Authorization).toBe("Bearer xoxb-test-bot-token");
  });

  test("handles conversations.open returning a bare string channel id", async () => {
    mockSlackFetch([{ body: { ok: true, channel: "D0C0FFEE" } }, { body: { ok: true, channel: "D0C0FFEE", ts: "1.2" } }]);

    const result = await runAction(sendDirectMessage, makeBotOnlyConnection(), { user: "U123", text: "hi" });
    expect(result.channel).toBe("D0C0FFEE");
  });

  test("as_user: true uses the user token for both calls", async () => {
    const { calls } = mockSlackFetch([
      { body: { ok: true, channel: { id: "D1" } } },
      { body: { ok: true, channel: "D1", ts: "1.2" } },
    ]);

    await runAction(sendDirectMessage, makeBotAndUserConnection(), { user: "U1", text: "hi", as_user: true });

    expect(calls[0]!.headers.Authorization).toBe("Bearer xoxp-test-user-token");
    expect(calls[1]!.headers.Authorization).toBe("Bearer xoxp-test-user-token");
  });

  test("fails fast on conversations.open error without attempting chat.postMessage", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: false, error: "user_not_found" } }]);

    await expect(runAction(sendDirectMessage, makeBotOnlyConnection(), { user: "UBAD", text: "hi" })).rejects.toThrow(
      /user_not_found/,
    );
    expect(calls.length).toBe(1); // never reached chat.postMessage
  });
});

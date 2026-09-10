// Mocked body per https://docs.slack.dev/reference/methods/chat.delete — see deleteMessage.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { deleteMessage } from "../../../src/components/slack/actions/deleteMessage";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("deleteMessage", () => {
  test("deletes a message", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: true, channel: "C1", ts: "1.2" } }]);

    const result = await runAction(deleteMessage, makeBotOnlyConnection(), { channel_id: "C1", ts: "1.2" });

    expect(result).toEqual({ ts: "1.2", channel: "C1" });
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.delete");
  });

  test("surfaces ok:false errors", async () => {
    mockSlackFetch([{ body: { ok: false, error: "message_not_found" } }]);
    await expect(runAction(deleteMessage, makeBotOnlyConnection(), { channel_id: "C1", ts: "1.2" })).rejects.toThrow(
      /message_not_found/,
    );
  });
});

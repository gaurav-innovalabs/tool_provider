// Mocked body per https://docs.slack.dev/reference/methods/chat.update — see updateMessage.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { updateMessage } from "../../../src/components/slack/actions/updateMessage";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("updateMessage", () => {
  test("edits an existing message", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: true, channel: "C1", ts: "1.2", text: "edited" } }]);

    const result = await runAction(updateMessage, makeBotOnlyConnection(), { channel: "C1", ts: "1.2", text: "edited" });

    expect(result).toEqual({ ts: "1.2", channel: "C1" });
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.update");
  });

  test("surfaces the identity-mismatch error verbatim", async () => {
    mockSlackFetch([{ body: { ok: false, error: "cant_update_message" } }]);
    await expect(
      runAction(updateMessage, makeBotOnlyConnection(), { channel: "C1", ts: "1.2", text: "edited" }),
    ).rejects.toThrow(/cant_update_message/);
  });
});

// Mocked body per https://docs.slack.dev/reference/methods/conversations.setTopic — see setChannelTopic.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { setChannelTopic } from "../../../src/components/slack/actions/setChannelTopic";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("setChannelTopic", () => {
  test("sets the topic", async () => {
    mockSlackFetch([{ body: { ok: true, topic: "new topic" } }]);
    const result = await runAction(setChannelTopic, makeBotOnlyConnection(), { channel: "C1", topic: "new topic" });
    expect(result).toEqual({ topic: "new topic" });
  });

  test("surfaces too_long", async () => {
    mockSlackFetch([{ body: { ok: false, error: "too_long" } }]);
    await expect(runAction(setChannelTopic, makeBotOnlyConnection(), { channel: "C1", topic: "x" })).rejects.toThrow(
      /too_long/,
    );
  });
});

// Mocked body per https://docs.slack.dev/reference/methods/conversations.create — see createChannel.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { createChannel } from "../../../src/components/slack/actions/createChannel";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("createChannel", () => {
  test("creates a public channel by default", async () => {
    const { calls } = mockSlackFetch([
      { body: { ok: true, channel: { id: "C0EAQDV4Z", name: "endeavor", is_private: false } } },
    ]);

    const result = await runAction(createChannel, makeBotOnlyConnection(), { name: "endeavor" });

    expect(result).toEqual({ id: "C0EAQDV4Z", name: "endeavor" });
    expect((calls[0]!.body as Record<string, unknown>).is_private).toBe(false);
  });

  test("surfaces name_taken", async () => {
    mockSlackFetch([{ body: { ok: false, error: "name_taken" } }]);
    await expect(runAction(createChannel, makeBotOnlyConnection(), { name: "dup" })).rejects.toThrow(/name_taken/);
  });
});

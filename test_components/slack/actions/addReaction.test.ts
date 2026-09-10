// Mocked body per https://docs.slack.dev/reference/methods/reactions.add — see addReaction.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { addReaction } from "../../../src/components/slack/actions/addReaction";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("addReaction", () => {
  test("sends `timestamp`, not `ts`, on the wire (reactions.* naming quirk)", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: true } }]);

    const result = await runAction(addReaction, makeBotOnlyConnection(), { channel_id: "C1", ts: "1.2", name: "thumbsup" });

    expect(result).toEqual({ ok: true });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.timestamp).toBe("1.2");
    expect(body.ts).toBeUndefined();
  });

  test("surfaces already_reacted", async () => {
    mockSlackFetch([{ body: { ok: false, error: "already_reacted" } }]);
    await expect(
      runAction(addReaction, makeBotOnlyConnection(), { channel_id: "C1", ts: "1.2", name: "thumbsup" }),
    ).rejects.toThrow(/already_reacted/);
  });
});

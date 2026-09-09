// Mocked body per https://docs.slack.dev/reference/methods/reactions.remove — see removeReaction.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { removeReaction } from "../../../src/components/slack/actions/removeReaction";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("removeReaction", () => {
  test("sends `timestamp`, not `ts`, on the wire", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: true } }]);

    const result = await runAction(removeReaction, makeBotOnlyConnection(), { channel: "C1", ts: "1.2", name: "thumbsup" });

    expect(result).toEqual({ ok: true });
    expect((calls[0]!.body as Record<string, unknown>).timestamp).toBe("1.2");
  });

  test("surfaces no_reaction", async () => {
    mockSlackFetch([{ body: { ok: false, error: "no_reaction" } }]);
    await expect(
      runAction(removeReaction, makeBotOnlyConnection(), { channel: "C1", ts: "1.2", name: "thumbsup" }),
    ).rejects.toThrow(/no_reaction/);
  });
});

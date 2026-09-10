// Mocked body per https://docs.slack.dev/reference/methods/conversations.archive — see archiveChannel.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { archiveChannel } from "../../../src/components/slack/actions/archiveChannel";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("archiveChannel", () => {
  test("archives a channel", async () => {
    mockSlackFetch([{ body: { ok: true } }]);
    const result = await runAction(archiveChannel, makeBotOnlyConnection(), { channel_id: "C1" });
    expect(result).toEqual({ ok: true });
  });

  test("surfaces already_archived", async () => {
    mockSlackFetch([{ body: { ok: false, error: "already_archived" } }]);
    await expect(runAction(archiveChannel, makeBotOnlyConnection(), { channel_id: "C1" })).rejects.toThrow(/already_archived/);
  });
});

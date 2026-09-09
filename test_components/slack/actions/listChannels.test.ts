// Mocked body shaped per https://docs.slack.dev/reference/methods/conversations.list — see listChannels.ts.

import { describe, test, expect, afterEach } from "bun:test";
import { listChannels } from "../../../src/components/slack/actions/listChannels";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("listChannels", () => {
  test("maps channels to the declared output shape", async () => {
    mockSlackFetch([
      {
        body: {
          ok: true,
          channels: [
            { id: "C111", name: "general", is_member: true },
            { id: "C222", name: "random", is_member: false },
          ],
          response_metadata: { next_cursor: "" },
        },
      },
    ]);

    const result = await runAction(listChannels, makeBotOnlyConnection(), {});

    expect(result).toEqual([
      { id: "C111", name: "general", is_member: true },
      { id: "C222", name: "random", is_member: false },
    ]);
  });

  test("applies the default limit=50 when omitted", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: true, channels: [] } }]);

    await runAction(listChannels, makeBotOnlyConnection(), {});

    expect(calls[0]!.url).toContain("limit=50");
  });

  test("surfaces ok:false errors", async () => {
    mockSlackFetch([{ body: { ok: false, error: "invalid_auth" } }]);
    await expect(runAction(listChannels, makeBotOnlyConnection(), {})).rejects.toThrow(/invalid_auth/);
  });
});

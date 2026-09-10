// Mocked body per https://docs.slack.dev/reference/methods/conversations.invite — see inviteUserToChannel.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { inviteUserToChannel } from "../../../src/components/slack/actions/inviteUserToChannel";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("inviteUserToChannel", () => {
  test("joins multiple user ids with a comma on the wire", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: true, channel: { id: "C1", name: "general" } } }]);

    const result = await runAction(inviteUserToChannel, makeBotOnlyConnection(), { channel_id: "C1", users: ["U1", "U2"] });

    expect(result).toEqual({ id: "C1", name: "general" });
    expect((calls[0]!.body as Record<string, unknown>).users).toBe("U1,U2");
  });

  test("surfaces already_in_channel", async () => {
    mockSlackFetch([{ body: { ok: false, error: "already_in_channel" } }]);
    await expect(
      runAction(inviteUserToChannel, makeBotOnlyConnection(), { channel_id: "C1", users: ["U1"] }),
    ).rejects.toThrow(/already_in_channel/);
  });
});

// Mocked body per https://docs.slack.dev/reference/methods/users.list — see listUsers.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { listUsers } from "../../../src/components/slack/actions/listUsers";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("listUsers", () => {
  test("maps members to the declared output shape, including deleted/deactivated members", async () => {
    mockSlackFetch([
      {
        body: {
          ok: true,
          members: [
            { id: "U1", name: "alice", real_name: "Alice A", deleted: false, is_bot: false, is_admin: true, profile: { email: "alice@example.com", image_192: "https://x/alice.png" } },
            { id: "U2", name: "botty", deleted: false, is_bot: true },
            { id: "U3", name: "old.employee", real_name: "Old Employee", deleted: true, is_bot: false },
          ],
        },
      },
    ]);

    const result = await runAction(listUsers, makeBotOnlyConnection(), {});

    expect(result).toEqual([
      {
        id: "U1",
        name: "alice",
        real_name: "Alice A",
        email: "alice@example.com",
        deleted: false,
        is_bot: false,
        is_admin: true,
        is_owner: undefined,
        is_restricted: undefined,
        is_ultra_restricted: undefined,
        tz: undefined,
        avatar_url: "https://x/alice.png",
      },
      {
        id: "U2",
        name: "botty",
        real_name: undefined,
        email: undefined,
        deleted: false,
        is_bot: true,
        is_admin: undefined,
        is_owner: undefined,
        is_restricted: undefined,
        is_ultra_restricted: undefined,
        tz: undefined,
        avatar_url: undefined,
      },
      {
        id: "U3",
        name: "old.employee",
        real_name: "Old Employee",
        email: undefined,
        deleted: true,
        is_bot: false,
        is_admin: undefined,
        is_owner: undefined,
        is_restricted: undefined,
        is_ultra_restricted: undefined,
        tz: undefined,
        avatar_url: undefined,
      },
    ]);
  });

  test("surfaces ok:false errors", async () => {
    mockSlackFetch([{ body: { ok: false, error: "invalid_auth" } }]);
    await expect(runAction(listUsers, makeBotOnlyConnection(), {})).rejects.toThrow(/invalid_auth/);
  });
});

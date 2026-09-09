// Mocked body per https://docs.slack.dev/reference/methods/users.list — see listUsers.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { listUsers } from "../../../src/components/slack/actions/listUsers";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("listUsers", () => {
  test("maps members to the declared output shape", async () => {
    mockSlackFetch([
      {
        body: {
          ok: true,
          members: [
            { id: "U1", name: "alice", real_name: "Alice A", is_bot: false },
            { id: "U2", name: "botty", is_bot: true },
          ],
        },
      },
    ]);

    const result = await runAction(listUsers, makeBotOnlyConnection(), {});

    expect(result).toEqual([
      { id: "U1", name: "alice", real_name: "Alice A", is_bot: false },
      { id: "U2", name: "botty", real_name: undefined, is_bot: true },
    ]);
  });

  test("surfaces ok:false errors", async () => {
    mockSlackFetch([{ body: { ok: false, error: "invalid_auth" } }]);
    await expect(runAction(listUsers, makeBotOnlyConnection(), {})).rejects.toThrow(/invalid_auth/);
  });
});

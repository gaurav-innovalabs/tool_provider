// Mocked body per https://docs.slack.dev/reference/methods/users.lookupByEmail — see findUserByEmail.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { findUserByEmail } from "../../../src/components/slack/actions/findUserByEmail";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("findUserByEmail", () => {
  test("finds a user and passes the email as a query param", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: true, user: { id: "U1", name: "alice", real_name: "Alice A" } } }]);

    const result = await runAction(findUserByEmail, makeBotOnlyConnection(), { email: "alice@example.com" });

    expect(result).toEqual({ id: "U1", name: "alice", real_name: "Alice A" });
    expect(calls[0]!.url).toContain(encodeURIComponent("alice@example.com"));
  });

  test("surfaces users_not_found", async () => {
    mockSlackFetch([{ body: { ok: false, error: "users_not_found" } }]);
    await expect(runAction(findUserByEmail, makeBotOnlyConnection(), { email: "nobody@example.com" })).rejects.toThrow(
      /users_not_found/,
    );
  });

  test("rejects a malformed email before ever calling Slack (schema reused from the action's declaration)", () => {
    expect(() => findUserByEmail.input.parse({ email: "not-an-email" })).toThrow();
  });
});

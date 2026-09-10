// Mocked response shaped per users.labels.get.

import { describe, test, expect, afterEach } from "bun:test";
import { getLabel } from "../../../src/components/gmail/actions/getLabel";
import { makeGmailConnection, mockGmailFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("getLabel", () => {
  test("maps a label response, including message counts", async () => {
    const { calls } = mockGmailFetch([
      { body: { id: "Label_1", name: "Work", type: "user", messagesTotal: 12, messagesUnread: 3 } },
    ]);

    const result = await runAction(getLabel, makeGmailConnection(), { label_id: "Label_1" });

    expect(result).toEqual({ id: "Label_1", name: "Work", type: "user", messages_total: 12, messages_unread: 3 });
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels/Label_1");
  });

  test("coerces any non-'system' type to 'user'", async () => {
    mockGmailFetch([{ body: { id: "INBOX", name: "INBOX", type: "system" } }]);
    const result = await runAction(getLabel, makeGmailConnection(), { label_id: "INBOX" });
    expect(result.type).toBe("system");
  });

  test("surfaces a 404 as an error", async () => {
    mockGmailFetch([{ status: 404, body: { error: { message: "Label not found" } } }]);
    await expect(runAction(getLabel, makeGmailConnection(), { label_id: "nope" })).rejects.toThrow(/404/);
  });
});

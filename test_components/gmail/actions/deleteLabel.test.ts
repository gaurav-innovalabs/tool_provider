// Gmail returns 204 No Content on a successful users.labels.delete — no JSON body to parse.

import { describe, test, expect, afterEach } from "bun:test";
import { deleteLabel } from "../../../src/components/gmail/actions/deleteLabel";
import { makeGmailConnection, mockGmailFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("deleteLabel", () => {
  test("DELETEs the label and returns { deleted: true } on a 204", async () => {
    const { calls } = mockGmailFetch([{ status: 204, body: null }]);

    const result = await runAction(deleteLabel, makeGmailConnection(), { label_id: "Label_1" });

    expect(result).toEqual({ deleted: true });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels/Label_1");
  });

  test("surfaces Gmail rejecting deletion of a system label", async () => {
    mockGmailFetch([{ status: 400, body: { error: { message: "Cannot delete system label" } } }]);
    await expect(runAction(deleteLabel, makeGmailConnection(), { label_id: "INBOX" })).rejects.toThrow(/400/);
  });
});

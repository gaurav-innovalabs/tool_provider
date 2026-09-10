// Mocked response shaped per users.labels.patch.

import { describe, test, expect, afterEach } from "bun:test";
import { updateLabel } from "../../../src/components/gmail/actions/updateLabel";
import { makeGmailConnection, mockGmailFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("updateLabel", () => {
  test("PATCHes the new name and returns id/name", async () => {
    const { calls } = mockGmailFetch([{ body: { id: "Label_1", name: "Renamed" } }]);

    const result = await runAction(updateLabel, makeGmailConnection(), { label_id: "Label_1", name: "Renamed" });

    expect(result).toEqual({ id: "Label_1", name: "Renamed" });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels/Label_1");
    expect(calls[0]!.body).toEqual({ name: "Renamed" });
  });

  test("surfaces Gmail rejecting a system-label rename", async () => {
    mockGmailFetch([{ status: 400, body: { error: { message: "Cannot rename system labels" } } }]);
    await expect(runAction(updateLabel, makeGmailConnection(), { label_id: "INBOX", name: "x" })).rejects.toThrow(/400/);
  });
});

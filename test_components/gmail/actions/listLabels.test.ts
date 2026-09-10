// Mocked response shaped per users.labels.list.

import { describe, test, expect, afterEach } from "bun:test";
import { listLabels } from "../../../src/components/gmail/actions/listLabels";
import { makeGmailConnection, mockGmailFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("listLabels", () => {
  test("maps labels to the declared output shape", async () => {
    mockGmailFetch([
      {
        body: {
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "Label_1", name: "Work", type: "user" },
          ],
        },
      },
    ]);

    const result = await runAction(listLabels, makeGmailConnection(), {});

    expect(result).toEqual([
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "Label_1", name: "Work", type: "user" },
    ]);
  });

  test("returns an empty array when the account has no labels field at all", async () => {
    mockGmailFetch([{ body: {} }]);
    expect(await runAction(listLabels, makeGmailConnection(), {})).toEqual([]);
  });

  test("surfaces a non-ok response as an error", async () => {
    mockGmailFetch([{ status: 500, body: { error: { message: "backend error" } } }]);
    await expect(runAction(listLabels, makeGmailConnection(), {})).rejects.toThrow(/500/);
  });
});

// Mocked responses shaped per users.getProfile + users.history.list (historyTypes=labelAdded).

import { describe, test, expect, afterEach } from "bun:test";
import { newLabeledEmail } from "../../../src/components/gmail/triggers/newLabeledEmail";
import { makeGmailConnection, mockGmailFetch, runPoll } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("newLabeledEmail", () => {
  test("seeds the cursor on the first poll, with no events", async () => {
    mockGmailFetch([{ body: { historyId: "1000" } }]);
    const result = await runPoll(newLabeledEmail, makeGmailConnection(), null);
    expect(result).toEqual({ events: [], nextCursor: { historyId: "1000" } });
  });

  test("returns one event per message with any label(s) newly added, for ALL labels (no per-instance filter)", async () => {
    mockGmailFetch([
      {
        body: {
          historyId: "1010",
          history: [
            { labelsAdded: [{ message: { id: "m1" }, labelIds: ["Label_1"] }] },
            { labelsAdded: [{ message: { id: "m2" }, labelIds: ["STARRED", "IMPORTANT"] }] },
          ],
        },
      },
    ]);

    const result = await runPoll(newLabeledEmail, makeGmailConnection(), { historyId: "1000" });

    expect(result.events).toEqual([
      { message_id: "m1", label_ids_added: ["Label_1"] },
      { message_id: "m2", label_ids_added: ["STARRED", "IMPORTANT"] },
    ]);
  });

  test("reseeds on a 404 (historyId fell out of retention)", async () => {
    mockGmailFetch([{ status: 404, body: { error: { code: 404, message: "not found" } } }, { body: { historyId: "2000" } }]);
    const result = await runPoll(newLabeledEmail, makeGmailConnection(), { historyId: "old" });
    expect(result).toEqual({ events: [], nextCursor: { historyId: "2000" } });
  });
});

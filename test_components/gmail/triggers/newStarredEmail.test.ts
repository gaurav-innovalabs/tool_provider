// Mocked responses shaped per users.getProfile + users.history.list (historyTypes=labelAdded), filtered
// for the STARRED system label — starring a message is just Gmail applying that label.

import { describe, test, expect, afterEach } from "bun:test";
import { newStarredEmail } from "../../../src/components/gmail/triggers/newStarredEmail";
import { makeGmailConnection, mockGmailFetch, runPoll } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("newStarredEmail", () => {
  test("seeds the cursor on the first poll, with no events", async () => {
    mockGmailFetch([{ body: { historyId: "1000" } }]);
    const result = await runPoll(newStarredEmail, makeGmailConnection(), null);
    expect(result).toEqual({ events: [], nextCursor: { historyId: "1000" } });
  });

  test("keeps only labelAdded entries that include STARRED", async () => {
    mockGmailFetch([
      {
        body: {
          historyId: "1010",
          history: [
            { labelsAdded: [{ message: { id: "m1" }, labelIds: ["STARRED"] }] },
            { labelsAdded: [{ message: { id: "m2" }, labelIds: ["Label_1"] }] },
          ],
        },
      },
    ]);

    const result = await runPoll(newStarredEmail, makeGmailConnection(), { historyId: "1000" });

    expect(result.events).toEqual([{ message_id: "m1" }]);
  });
});

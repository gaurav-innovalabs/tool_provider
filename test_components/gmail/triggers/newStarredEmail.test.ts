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

  test("keeps only labelAdded entries that include STARRED, enriched with the message's own from/to/subject/snippet/received_at", async () => {
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
      {
        body: {
          id: "m1",
          snippet: "hi",
          internalDate: "1700000000000",
          payload: { headers: [{ name: "From", value: "a@b.com" }, { name: "To", value: "me@x.com" }, { name: "Subject", value: "Starred one" }] },
        },
      },
    ]);

    const result = await runPoll(newStarredEmail, makeGmailConnection(), { historyId: "1000" });

    expect(result.events).toEqual([
      {
        message_id: "m1",
        from: "a@b.com",
        to: "me@x.com",
        subject: "Starred one",
        snippet: "hi",
        received_at: new Date(1700000000000).toISOString(),
      },
    ]);
  });

  test("skips a message that 404s instead of aborting the whole poll (cursor still advances)", async () => {
    mockGmailFetch([
      {
        body: {
          historyId: "1020",
          history: [{ labelsAdded: [{ message: { id: "m-gone" }, labelIds: ["STARRED"] }] }],
        },
      },
      { status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } },
    ]);

    const result = await runPoll(newStarredEmail, makeGmailConnection(), { historyId: "1000" });

    expect(result.events).toEqual([]);
    expect(result.nextCursor).toEqual({ historyId: "1020" });
  });
});

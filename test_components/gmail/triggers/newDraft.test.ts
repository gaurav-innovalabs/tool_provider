// Mocked responses shaped per users.getProfile + users.history.list (historyTypes=messageAdded) +
// users.messages.get — filters for the DRAFT system label since Gmail has no dedicated historyType for it.

import { describe, test, expect, afterEach } from "bun:test";
import { newDraft } from "../../../src/components/gmail/triggers/newDraft";
import { makeGmailConnection, mockGmailFetch, runPoll } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("newDraft", () => {
  test("seeds the cursor on the first poll, with no events", async () => {
    mockGmailFetch([{ body: { historyId: "1000" } }]);
    const result = await runPoll(newDraft, makeGmailConnection(), null);
    expect(result).toEqual({ events: [], nextCursor: { historyId: "1000" } });
  });

  test("fetches each new message and keeps only ones carrying the DRAFT label", async () => {
    mockGmailFetch([
      { body: { historyId: "1010", history: [{ messagesAdded: [{ message: { id: "m1" } }] }] } },
      {
        body: {
          id: "m1",
          labelIds: ["DRAFT"],
          snippet: "not sent yet",
          internalDate: "1700000000000",
          payload: { headers: [{ name: "From", value: "me@x.com" }, { name: "To", value: "x@y.com" }, { name: "Subject", value: "WIP" }] },
        },
      },
    ]);

    const result = await runPoll(newDraft, makeGmailConnection(), { historyId: "1000" });

    expect(result.events).toEqual([
      { message_id: "m1", from: "me@x.com", to: "x@y.com", subject: "WIP", snippet: "not sent yet", updated_at: new Date(1700000000000).toISOString() },
    ]);
  });
});

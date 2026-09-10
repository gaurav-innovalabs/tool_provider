// Mocked responses shaped per users.getProfile + users.history.list (historyTypes=messageAdded) +
// users.messages.get — filters for the SENT system label since Gmail has no dedicated historyType for it.

import { describe, test, expect, afterEach } from "bun:test";
import { newSentEmail } from "../../../src/components/gmail/triggers/newSentEmail";
import { makeGmailConnection, mockGmailFetch, runPoll } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("newSentEmail", () => {
  test("seeds the cursor on the first poll, with no events", async () => {
    mockGmailFetch([{ body: { historyId: "1000" } }]);
    const result = await runPoll(newSentEmail, makeGmailConnection(), null);
    expect(result).toEqual({ events: [], nextCursor: { historyId: "1000" } });
  });

  test("fetches each new message and keeps only ones carrying the SENT label", async () => {
    mockGmailFetch([
      {
        body: {
          historyId: "1010",
          history: [{ messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m2" } }] }],
        },
      },
      {
        body: {
          id: "m1",
          labelIds: ["SENT"],
          snippet: "sent one",
          payload: { headers: [{ name: "To", value: "x@y.com" }, { name: "Subject", value: "Out" }] },
        },
      },
      {
        body: {
          id: "m2",
          labelIds: ["INBOX"],
          snippet: "inbound one",
          payload: { headers: [{ name: "To", value: "me@y.com" }, { name: "Subject", value: "In" }] },
        },
      },
    ]);

    const result = await runPoll(newSentEmail, makeGmailConnection(), { historyId: "1000" });

    expect(result.events).toEqual([{ message_id: "m1", to: "x@y.com", subject: "Out", snippet: "sent one" }]);
    expect(result.nextCursor).toEqual({ historyId: "1010" });
  });
});

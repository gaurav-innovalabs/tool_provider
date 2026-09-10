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

  test("returns one event per message with any label(s) newly added, for ALL labels (no per-instance filter), enriched with the message's own from/to/subject/snippet/received_at", async () => {
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
      {
        body: {
          id: "m1",
          snippet: "hi one",
          internalDate: "1700000000000",
          payload: { headers: [{ name: "From", value: "a@b.com" }, { name: "To", value: "me@x.com" }, { name: "Subject", value: "One" }] },
        },
      },
      {
        body: {
          id: "m2",
          snippet: "hi two",
          internalDate: "1700000000001",
          payload: { headers: [{ name: "From", value: "c@d.com" }, { name: "To", value: "me@x.com" }, { name: "Subject", value: "Two" }] },
        },
      },
    ]);

    const result = await runPoll(newLabeledEmail, makeGmailConnection(), { historyId: "1000" });

    expect(result.events).toEqual([
      {
        message_id: "m1",
        label_ids_added: ["Label_1"],
        from: "a@b.com",
        to: "me@x.com",
        subject: "One",
        snippet: "hi one",
        received_at: new Date(1700000000000).toISOString(),
      },
      {
        message_id: "m2",
        label_ids_added: ["STARRED", "IMPORTANT"],
        from: "c@d.com",
        to: "me@x.com",
        subject: "Two",
        snippet: "hi two",
        received_at: new Date(1700000000001).toISOString(),
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

    const result = await runPoll(newLabeledEmail, makeGmailConnection(), { historyId: "1000" });

    expect(result.events).toEqual([]);
    expect(result.nextCursor).toEqual({ historyId: "1020" });
  });

  test("reseeds on a 404 (historyId fell out of retention)", async () => {
    mockGmailFetch([{ status: 404, body: { error: { code: 404, message: "not found" } } }, { body: { historyId: "2000" } }]);
    const result = await runPoll(newLabeledEmail, makeGmailConnection(), { historyId: "old" });
    expect(result).toEqual({ events: [], nextCursor: { historyId: "2000" } });
  });
});

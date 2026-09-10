// Mocked responses shaped per users.getProfile (cursor seed) + users.history.list (historyTypes=messageAdded)
// + users.messages.get (format=metadata).

import { describe, test, expect, afterEach } from "bun:test";
import { newEmail } from "../../../src/components/gmail/triggers/newEmail";
import { makeGmailConnection, mockGmailFetch, runPoll } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("newEmail", () => {
  test("seeds the cursor from getProfile on the first poll, with no events", async () => {
    const { calls } = mockGmailFetch([{ body: { historyId: "1000" } }]);

    const result = await runPoll(newEmail, makeGmailConnection(), null);

    expect(result).toEqual({ events: [], nextCursor: { historyId: "1000" } });
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
  });

  test("returns one event per new message, deduped, with From/Subject/snippet", async () => {
    mockGmailFetch([
      {
        body: {
          historyId: "1010",
          history: [{ messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m1" } }] }],
        },
      },
      {
        body: {
          id: "m1",
          snippet: "hi",
          payload: { headers: [{ name: "From", value: "a@b.com" }, { name: "Subject", value: "Hey" }] },
        },
      },
    ]);

    const result = await runPoll(newEmail, makeGmailConnection(), { historyId: "1000" });

    expect(result.events).toEqual([{ message_id: "m1", from: "a@b.com", subject: "Hey", snippet: "hi" }]);
    expect(result.nextCursor).toEqual({ historyId: "1010" });
  });

  test("reseeds instead of erroring when the cursor's historyId has fallen out of retention (404)", async () => {
    mockGmailFetch([
      { status: 404, body: { error: { code: 404, message: "startHistoryId not found" } } },
      { body: { historyId: "2000" } },
    ]);

    const result = await runPoll(newEmail, makeGmailConnection(), { historyId: "old" });

    expect(result).toEqual({ events: [], nextCursor: { historyId: "2000" } });
  });

  test("throws when the connection has no access_token", async () => {
    mockGmailFetch([]);
    await expect(runPoll(newEmail, makeGmailConnection({}), null)).rejects.toThrow(/access_token/);
  });
});

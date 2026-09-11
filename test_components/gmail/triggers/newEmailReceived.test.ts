// Mocked responses shaped per users.getProfile (cursor seed) + users.history.list (historyTypes=messageAdded,
// labelIds embedded directly on messagesAdded[].message — confirmed against a real live account, see
// newEmailReceived.ts's header comment) + users.messages.get (format=metadata, only for messages that
// already passed the INBOX filter above).

import { describe, test, expect, afterEach } from "bun:test";
import { newEmailReceived } from "../../../src/components/gmail/triggers/newEmailReceived";
import { makeGmailConnection, mockGmailFetch, runPoll } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("newEmailReceived", () => {
  test("seeds the cursor from getProfile on the first poll, with no events", async () => {
    const { calls } = mockGmailFetch([{ body: { historyId: "1000" } }]);

    const result = await runPoll(newEmailReceived, makeGmailConnection(), null);

    expect(result).toEqual({ events: [], nextCursor: { historyId: "1000" } });
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
  });

  test("returns one event per new message, deduped, with From/Subject/snippet", async () => {
    mockGmailFetch([
      {
        body: {
          historyId: "1010",
          history: [
            {
              messagesAdded: [
                { message: { id: "m1", labelIds: ["INBOX"] } },
                { message: { id: "m1", labelIds: ["INBOX"] } },
              ],
            },
          ],
        },
      },
      {
        body: {
          id: "m1",
          snippet: "hi",
          internalDate: "1700000000000",
          payload: { headers: [{ name: "From", value: "a@b.com" }, { name: "To", value: "me@x.com" }, { name: "Subject", value: "Hey" }] },
        },
      },
    ]);

    const result = await runPoll(newEmailReceived, makeGmailConnection(), { historyId: "1000" });

    expect(result.events).toEqual([
      { message_id: "m1", from: "a@b.com", to: "me@x.com", subject: "Hey", snippet: "hi", received_at: new Date(1700000000000).toISOString() },
    ]);
    expect(result.nextCursor).toEqual({ historyId: "1010" });
  });

  test("requires INBOX (filtered from the history.list response itself, before any messages.get call) — drafts, sent mail, and Gmail Chat messages must not fire, and must never even be fetched", async () => {
    const { calls } = mockGmailFetch([
      {
        body: {
          historyId: "1030",
          history: [
            {
              messagesAdded: [
                { message: { id: "m-draft", labelIds: ["DRAFT"] } },
                { message: { id: "m-sent", labelIds: ["SENT"] } },
                // A label that's neither DRAFT nor SENT — proves this is a positive INBOX check, not an
                // exclude list (an exclude list would let this false-positive through, exactly the loophole
                // a hardcoded DRAFT/SENT blocklist would miss for CHAT, or any future non-arrival label
                // Google adds later).
                { message: { id: "m-chat", labelIds: ["CHAT"] } },
                { message: { id: "m-real", labelIds: ["INBOX"] } },
              ],
            },
          ],
        },
      },
      {
        body: {
          id: "m-real",
          snippet: "actually arrived",
          internalDate: "1700000000002",
          payload: { headers: [{ name: "From", value: "a@b.com" }, { name: "To", value: "me@x.com" }, { name: "Subject", value: "Real" }] },
        },
      },
    ]);

    const result = await runPoll(newEmailReceived, makeGmailConnection(), { historyId: "1000" });

    expect(result.events).toEqual([
      { message_id: "m-real", from: "a@b.com", to: "me@x.com", subject: "Real", snippet: "actually arrived", received_at: new Date(1700000000002).toISOString() },
    ]);
    expect(result.nextCursor).toEqual({ historyId: "1030" });
    // Exactly 2 calls total: the history.list + ONE messages.get (for m-real only) — m-draft/m-sent/m-chat
    // never cost a fetch at all, proving the filter runs on history.list's own embedded labelIds, not on a
    // fetch-everything-then-filter pass.
    expect(calls).toHaveLength(2);
  });

  test("reseeds instead of erroring when the cursor's historyId has fallen out of retention (404)", async () => {
    mockGmailFetch([
      { status: 404, body: { error: { code: 404, message: "startHistoryId not found" } } },
      { body: { historyId: "2000" } },
    ]);

    const result = await runPoll(newEmailReceived, makeGmailConnection(), { historyId: "old" });

    expect(result).toEqual({ events: [], nextCursor: { historyId: "2000" } });
  });

  test("throws when the connection has no access_token", async () => {
    mockGmailFetch([]);
    await expect(runPoll(newEmailReceived, makeGmailConnection({}), null)).rejects.toThrow(/access_token/);
  });

  test("skips a message that 404s instead of aborting the whole poll (cursor still advances)", async () => {
    mockGmailFetch([
      {
        body: {
          historyId: "1020",
          history: [
            {
              messagesAdded: [
                { message: { id: "m-ok", labelIds: ["INBOX"] } },
                { message: { id: "m-gone", labelIds: ["INBOX"] } },
              ],
            },
          ],
        },
      },
      {
        body: {
          id: "m-ok",
          snippet: "still here",
          internalDate: "1700000000000",
          payload: { headers: [{ name: "From", value: "a@b.com" }, { name: "To", value: "me@x.com" }, { name: "Subject", value: "Hi" }] },
        },
      },
      { status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } },
    ]);

    const result = await runPoll(newEmailReceived, makeGmailConnection(), { historyId: "1000" });

    // The failing message is silently skipped (logged, not thrown) — NOT re-thrown, and critically the
    // cursor still advances to the new historyId, so the next poll moves forward instead of retrying the
    // same failing message forever (see newEmailReceived.ts's comment on why that would otherwise be
    // permanent).
    expect(result.events).toEqual([
      { message_id: "m-ok", from: "a@b.com", to: "me@x.com", subject: "Hi", snippet: "still here", received_at: new Date(1700000000000).toISOString() },
    ]);
    expect(result.nextCursor).toEqual({ historyId: "1020" });
  });
});

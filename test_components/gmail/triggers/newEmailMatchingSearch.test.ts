// Mocked responses shaped per users.messages.list (q=<query> after:<epoch_seconds>) + users.messages.get
// (format=metadata). See newEmailMatchingSearch.ts's header comment for why this trigger uses a timestamp
// cursor instead of newEmailReceived.ts's historyId one — Gmail's history.list has no search-query param.

import { describe, test, expect, afterEach } from "bun:test";
import { newEmailMatchingSearch } from "../../../src/components/gmail/triggers/newEmailMatchingSearch";
import { makeGmailConnection, mockGmailFetch, runPoll } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("newEmailMatchingSearch", () => {
  test("seeds the cursor to now on the first poll, with no events and no API call", async () => {
    const { calls } = mockGmailFetch([]);

    const result = await runPoll(newEmailMatchingSearch, makeGmailConnection(), null, { query: "from:boss@company.com" });

    expect(result.events).toEqual([]);
    expect(result.nextCursor.seen_ids_at_boundary).toEqual([]);
    expect(result.nextCursor.after_epoch_seconds).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  test("throws when the trigger_instance has no config.query", async () => {
    mockGmailFetch([]);
    await expect(
      runPoll(newEmailMatchingSearch, makeGmailConnection(), { after_epoch_seconds: 1000, seen_ids_at_boundary: [] }, undefined as never),
    ).rejects.toThrow(/config\.query/);
  });

  test("appends after:<epoch_seconds> to the configured query and advances the cursor to the max internalDate seen", async () => {
    const { calls } = mockGmailFetch([
      { body: { messages: [{ id: "m1" }] } },
      {
        body: {
          id: "m1",
          threadId: "t1",
          snippet: "urgent",
          internalDate: "1700000005000", // epoch second 1700000005
          payload: { headers: [{ name: "From", value: "boss@company.com" }, { name: "To", value: "me@x.com" }, { name: "Subject", value: "Ping" }] },
        },
      },
    ]);

    const result = await runPoll(
      newEmailMatchingSearch,
      makeGmailConnection(),
      { after_epoch_seconds: 1700000000, seen_ids_at_boundary: [] },
      { query: "from:boss@company.com" },
    );

    expect(decodeURIComponent(calls[0]!.url.replace(/\+/g, " "))).toContain("q=from:boss@company.com after:1700000000");
    expect(result.events).toEqual([
      { message_id: "m1", thread_id: "t1", from: "boss@company.com", to: "me@x.com", subject: "Ping", snippet: "urgent", received_at: new Date(1700000005000).toISOString() },
    ]);
    expect(result.nextCursor).toEqual({ after_epoch_seconds: 1700000005, seen_ids_at_boundary: ["m1"] });
  });

  test("never redelivers a message already recorded at the current boundary second — the loophole a plain after: re-query alone would hit", async () => {
    const { calls } = mockGmailFetch([{ body: { messages: [{ id: "m-old" }, { id: "m-new" }] } }, { body: { id: "m-new", threadId: "t2", snippet: "s", internalDate: "1700000010000", payload: { headers: [] } } }]);

    const result = await runPoll(
      newEmailMatchingSearch,
      makeGmailConnection(),
      { after_epoch_seconds: 1700000010, seen_ids_at_boundary: ["m-old"] },
      { query: "is:important" },
    );

    // m-old is skipped without ever being fetched (only 2 calls total: list + ONE get, for m-new).
    expect(calls).toHaveLength(2);
    expect(result.events.map((e) => e.message_id)).toEqual(["m-new"]);
    expect(result.nextCursor.seen_ids_at_boundary.sort()).toEqual(["m-new", "m-old"]);
  });

  test("keeps the cursor unchanged when nothing new matches — safe to re-query the same after: bound next time", async () => {
    mockGmailFetch([{ body: { messages: [] } }]);

    const result = await runPoll(
      newEmailMatchingSearch,
      makeGmailConnection(),
      { after_epoch_seconds: 1700000000, seen_ids_at_boundary: ["m-old"] },
      { query: "is:important" },
    );

    expect(result.events).toEqual([]);
    expect(result.nextCursor).toEqual({ after_epoch_seconds: 1700000000, seen_ids_at_boundary: ["m-old"] });
  });

  test("skips a message that 404s instead of aborting the whole poll", async () => {
    mockGmailFetch([
      { body: { messages: [{ id: "m-ok" }, { id: "m-gone" }] } },
      {
        body: {
          id: "m-ok",
          threadId: "t3",
          snippet: "still here",
          internalDate: "1700000020000",
          payload: { headers: [{ name: "From", value: "a@b.com" }, { name: "To", value: "me@x.com" }, { name: "Subject", value: "Hi" }] },
        },
      },
      { status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } },
    ]);

    const result = await runPoll(
      newEmailMatchingSearch,
      makeGmailConnection(),
      { after_epoch_seconds: 1700000000, seen_ids_at_boundary: [] },
      { query: "is:important" },
    );

    expect(result.events).toEqual([
      { message_id: "m-ok", thread_id: "t3", from: "a@b.com", to: "me@x.com", subject: "Hi", snippet: "still here", received_at: new Date(1700000020000).toISOString() },
    ]);
    expect(result.nextCursor).toEqual({ after_epoch_seconds: 1700000020, seen_ids_at_boundary: ["m-ok"] });
  });

  test("throws when the connection has no access_token", async () => {
    mockGmailFetch([]);
    await expect(
      runPoll(newEmailMatchingSearch, makeGmailConnection({}), { after_epoch_seconds: 1000, seen_ids_at_boundary: [] }, { query: "x" }),
    ).rejects.toThrow(/access_token/);
  });
});

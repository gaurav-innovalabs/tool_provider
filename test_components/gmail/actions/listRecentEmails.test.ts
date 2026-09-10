// Mocked responses shaped per users.messages.list + users.messages.get (format=metadata).

import { describe, test, expect, afterEach } from "bun:test";
import { listRecentEmails } from "../../../src/components/gmail/actions/listRecentEmails";
import { makeGmailConnection, mockGmailFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("listRecentEmails", () => {
  test("lists messages and maps headers/snippet/received_at", async () => {
    mockGmailFetch([
      { body: { messages: [{ id: "m1" }] } },
      {
        body: {
          id: "m1",
          snippet: "hi there",
          internalDate: "1700000000000",
          payload: { headers: [{ name: "From", value: "a@b.com" }, { name: "Subject", value: "Hey" }] },
        },
      },
    ]);

    const result = await runAction(listRecentEmails, makeGmailConnection(), {});

    expect(result).toEqual([
      {
        id: "m1",
        from: "a@b.com",
        subject: "Hey",
        snippet: "hi there",
        received_at: new Date(1700000000000).toISOString(),
      },
    ]);
  });

  test("applies the default max_results=10 and passes through an optional query", async () => {
    const { calls } = mockGmailFetch([{ body: { messages: [] } }]);

    await runAction(listRecentEmails, makeGmailConnection(), { query: "is:unread" });

    expect(calls[0]!.url).toContain("maxResults=10");
    expect(calls[0]!.url).toContain("q=is%3Aunread");
  });

  test("returns an empty array when there are no messages (no per-message fetches made)", async () => {
    const { calls } = mockGmailFetch([{ body: {} }]);
    const result = await runAction(listRecentEmails, makeGmailConnection(), {});
    expect(result).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("surfaces a non-ok list response as an error", async () => {
    mockGmailFetch([{ status: 401, body: { error: { message: "invalid credentials" } } }]);
    await expect(runAction(listRecentEmails, makeGmailConnection(), {})).rejects.toThrow(/401/);
  });
});

// Mocked response shaped per users.drafts.create.

import { describe, test, expect, afterEach } from "bun:test";
import { createDraft } from "../../../src/components/gmail/actions/createDraft";
import { makeGmailConnection, mockGmailFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("createDraft", () => {
  test("wraps the RFC 2822 message in a { message: { raw } } envelope and returns both ids", async () => {
    const { calls } = mockGmailFetch([{ body: { id: "draft123", message: { id: "msg456" } } }]);

    const result = await runAction(createDraft, makeGmailConnection(), {
      to: "someone@example.com",
      subject: "Draft",
      body: "Not sent yet.",
    });

    expect(result).toEqual({ draft_id: "draft123", message_id: "msg456" });
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    expect(calls[0]!.method).toBe("POST");

    const body = calls[0]!.body as { message: { raw: string } };
    const decoded = Buffer.from(body.message.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    expect(decoded).toContain("Subject: Draft");
  });

  test("surfaces a non-ok response as an error", async () => {
    mockGmailFetch([{ status: 400, body: { error: { message: "Invalid message" } } }]);
    await expect(
      runAction(createDraft, makeGmailConnection(), { to: "someone@example.com", subject: "x", body: "y" }),
    ).rejects.toThrow(/400/);
  });
});

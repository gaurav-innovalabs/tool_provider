// Mocked response shaped per https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send

import { describe, test, expect, afterEach } from "bun:test";
import { sendEmail } from "../../../src/components/gmail/actions/sendEmail";
import { makeGmailConnection, mockGmailFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error — restoring after each mockGmailFetch install
  delete global.fetch;
});

describe("sendEmail", () => {
  test("sends a base64url-encoded RFC 2822 message and returns the message_id", async () => {
    const { calls } = mockGmailFetch([{ body: { id: "18abc123" } }]);

    const result = await runAction(sendEmail, makeGmailConnection(), {
      to: "someone@example.com",
      subject: "Hello",
      body: "Testing.",
    });

    expect(result).toEqual({ message_id: "18abc123" });
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toBe("Bearer ya29.test-access-token");

    const body = calls[0]!.body as { raw: string };
    const decoded = Buffer.from(body.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    expect(decoded).toContain("To: someone@example.com");
    expect(decoded).toContain("Subject: Hello");
  });

  test("throws when the connection has no access_token", async () => {
    mockGmailFetch([]);
    await expect(
      runAction(sendEmail, makeGmailConnection({}), { to: "someone@example.com", subject: "Hi", body: "x" }),
    ).rejects.toThrow(/access_token/);
  });

  test("surfaces a non-ok response as an error", async () => {
    mockGmailFetch([{ status: 403, body: { error: { message: "Insufficient Permission" } } }]);
    await expect(
      runAction(sendEmail, makeGmailConnection(), { to: "someone@example.com", subject: "Hi", body: "x" }),
    ).rejects.toThrow(/403/);
  });

  test("rejects input with an invalid email (schema reused from the action's own declaration)", () => {
    expect(() => sendEmail.input.parse({ to: "not-an-email", subject: "Hi", body: "x" })).toThrow();
  });
});

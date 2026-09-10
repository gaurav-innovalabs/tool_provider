// Mocked response shaped per users.labels.create.

import { describe, test, expect, afterEach } from "bun:test";
import { createLabel } from "../../../src/components/gmail/actions/createLabel";
import { makeGmailConnection, mockGmailFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("createLabel", () => {
  test("posts the label name and returns id/name", async () => {
    const { calls } = mockGmailFetch([{ body: { id: "Label_99", name: "TestLabel" } }]);

    const result = await runAction(createLabel, makeGmailConnection(), { name: "TestLabel" });

    expect(result).toEqual({ id: "Label_99", name: "TestLabel" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ name: "TestLabel" });
  });

  test("rejects an empty name (schema reused from the action's own declaration)", () => {
    expect(() => createLabel.input.parse({ name: "" })).toThrow();
  });

  test("surfaces a non-ok response as an error", async () => {
    mockGmailFetch([{ status: 409, body: { error: { message: "Label name exists or conflicts" } } }]);
    await expect(runAction(createLabel, makeGmailConnection(), { name: "Dup" })).rejects.toThrow(/409/);
  });
});

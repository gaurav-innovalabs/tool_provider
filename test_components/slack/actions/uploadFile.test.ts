// Mocked bodies per https://docs.slack.dev/reference/methods/files.getUploadURLExternal and
// https://docs.slack.dev/reference/methods/files.completeUploadExternal — see uploadFile.ts's header.

import { describe, test, expect, afterEach } from "bun:test";
import { uploadFile } from "../../../src/components/slack/actions/uploadFile";
import { makeBotOnlyConnection, mockSlackFetch, runAction } from "../testUtils";

afterEach(() => {
  // @ts-expect-error
  delete global.fetch;
});

describe("uploadFile", () => {
  test("runs the 3-step external upload flow in order", async () => {
    const { calls } = mockSlackFetch([
      { body: { ok: true, upload_url: "https://files.slack.com/upload/v1/ABC123", file_id: "F123ABC456" } },
      { body: {} }, // the raw PUT to upload_url isn't a Slack Web API call, no ok/error envelope
      { body: { ok: true, files: [{ id: "F123ABC456", title: "hello.txt" }] } },
    ]);

    const result = await runAction(uploadFile, makeBotOnlyConnection(), {
      channel_id: "C1",
      filename: "hello.txt",
      content_base64: Buffer.from("hello world").toString("base64"),
    });

    expect(result).toEqual({ file_id: "F123ABC456" });
    expect(calls[0]!.url).toBe("https://slack.com/api/files.getUploadURLExternal");
    expect(calls[1]!.url).toBe("https://files.slack.com/upload/v1/ABC123");
    expect(calls[2]!.url).toBe("https://slack.com/api/files.completeUploadExternal");
    const completeBody = calls[2]!.body as Record<string, unknown>;
    expect(completeBody.channel_id).toBe("C1");
    expect(completeBody.files).toEqual([{ id: "F123ABC456", title: "hello.txt" }]);
  });

  test("uses the given title over the filename when provided", async () => {
    mockSlackFetch([
      { body: { ok: true, upload_url: "https://files.slack.com/upload/v1/X", file_id: "F1" } },
      { body: {} },
      { body: { ok: true, files: [{ id: "F1", title: "Custom title" }] } },
    ]);

    await runAction(uploadFile, makeBotOnlyConnection(), {
      channel_id: "C1",
      filename: "hello.txt",
      content_base64: Buffer.from("hi").toString("base64"),
      title: "Custom title",
    });
  });

  test("fails fast if files.getUploadURLExternal errors, never reaching the upload or complete steps", async () => {
    const { calls } = mockSlackFetch([{ body: { ok: false, error: "invalid_auth" } }]);

    await expect(
      runAction(uploadFile, makeBotOnlyConnection(), { channel_id: "C1", filename: "x.txt", content_base64: "aGk=" }),
    ).rejects.toThrow(/invalid_auth/);
    expect(calls.length).toBe(1);
  });

  test("fails if files.completeUploadExternal errors after a successful upload", async () => {
    mockSlackFetch([
      { body: { ok: true, upload_url: "https://files.slack.com/upload/v1/X", file_id: "F1" } },
      { body: {} },
      { body: { ok: false, error: "invalid_files" } },
    ]);

    await expect(
      runAction(uploadFile, makeBotOnlyConnection(), { channel_id: "C1", filename: "x.txt", content_base64: "aGk=" }),
    ).rejects.toThrow(/invalid_files/);
  });
});

// API reference:
//   https://docs.slack.dev/reference/methods/files.getUploadURLExternal (bot scope: files:write)
//     response: { ok, upload_url, file_id } — verified against the doc; { ok: false, error } on failure.
//   https://docs.slack.dev/reference/methods/files.completeUploadExternal (bot scope: files:write)
//     response: { ok, files: [{ id, title }] } — verified against the doc.
//   https://docs.slack.dev/messaging/files#uploading_files — overview of the 3-step flow.
// Approach: Slack deprecated the old single-call files.upload (removed for new apps as of 2025-03-11) in
// favor of this 3-step flow: files.getUploadURLExternal (get a pre-signed upload URL) -> POST the raw
// bytes to that URL -> files.completeUploadExternal (finalize + optionally share to a channel).

import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeSlackError } from "../../../lib/slackErrors";

const input = z.object({
  // files.completeUploadExternal's own wire param IS literally `channel_id` (unlike every other Slack
  // method here, which calls it `channel` on the wire but still means an ID) — requires the real channel
  // ID either way, Slack does NOT resolve a "#name" here.
  channel_id: z.string().min(1).describe("Channel ID, e.g. from list_channels — NOT a #channel-name"),
  filename: z.string().min(1),
  content_base64: z.string().min(1), // file bytes, base64-encoded
  title: z.string().optional(),
});

const output = z.object({
  file_id: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

interface GetUploadUrlResponse extends SlackApiResponse {
  upload_url?: string;
  file_id?: string;
}

export const uploadFile: ActionDefinition<Input, Output> = {
  key: "upload_file",
  description: "Upload a file to a Slack channel.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const token = connection.secrets!.access_token;
    const bytes = Buffer.from(params.content_base64, "base64");

    const urlRes = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ filename: params.filename, length: String(bytes.length) }),
    });
    const urlData = (await urlRes.json()) as GetUploadUrlResponse;
    if (!urlRes.ok || !urlData.ok || !urlData.upload_url || !urlData.file_id) {
      throw new Error(`Slack upload_file (files.getUploadURLExternal) failed: ${describeSlackError(urlData.error ?? urlRes.statusText)}`);
    }

    const putRes = await fetch(urlData.upload_url, { method: "POST", body: bytes });
    if (!putRes.ok) {
      throw new Error(`Slack upload_file failed uploading bytes to the pre-signed URL: ${putRes.statusText}`);
    }

    const completeRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        files: [{ id: urlData.file_id, title: params.title ?? params.filename }],
        channel_id: params.channel_id,
      }),
    });
    const completeData = (await completeRes.json()) as SlackApiResponse;
    if (!completeRes.ok || !completeData.ok) {
      throw new Error(`Slack upload_file (files.completeUploadExternal) failed: ${describeSlackError(completeData.error ?? completeRes.statusText)}`);
    }

    return { file_id: urlData.file_id };
  },
};

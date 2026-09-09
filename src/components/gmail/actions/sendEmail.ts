// No `googleapis` dependency — Gmail's REST API is plain HTTP, `fetch` + a Bearer token is enough and
// keeps this lite (googleapis is a huge generated multi-service client we'd use ~1% of).

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string(),
  // TODO(ask): cc/bcc/attachments — out of scope for this first cut, add if actually needed.
});

const output = z.object({
  message_id: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

function toBase64Url(str: string): string {
  return Buffer.from(str).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const sendEmail: ActionDefinition<Input, Output> = {
  key: "send_email",
  description: "Send a plain-text email from the connected Gmail account.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    // RFC 2822 message — Gmail's `raw` field is base64url of this, no MIME libraries needed for plain text.
    const raw = toBase64Url(
      [`To: ${params.to}`, `Subject: ${params.subject}`, "Content-Type: text/plain; charset=utf-8", "", params.body].join(
        "\r\n",
      ),
    );

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets!.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gmail send_email failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { id: string };
    return { message_id: data.id };
  },
};

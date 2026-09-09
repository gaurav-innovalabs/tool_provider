// Real action, per Pipedream's actual gmail-create-draft — the only draft-related action they ship (no
// send-draft/list-drafts/delete-draft in their Gmail component at all, confirmed by listing their real
// actions directory). Same shape as sendEmail.ts, but POSTs to /drafts instead of /messages/send — Gmail
// wraps the same RFC 2822 message in a `{ message: { raw } }` envelope for drafts.
//
// Simplified vs. Pipedream's version, same "lite" pattern as sendEmail.ts: no attachments, no
// reply-threading (inReplyToMessageId), no from-name/from-email aliasing. Add if actually needed.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string(),
});

const output = z.object({
  draft_id: z.string(),
  message_id: z.string(),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

function toBase64Url(str: string): string {
  return Buffer.from(str).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface GmailDraftCreateResponse {
  id: string;
  message: { id: string };
}

export const createDraft: ActionDefinition<Input, Output> = {
  key: "create_draft",
  description: "Create an unsent draft in the connected Gmail account.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }

    const raw = toBase64Url(
      [`To: ${params.to}`, `Subject: ${params.subject}`, "Content-Type: text/plain; charset=utf-8", "", params.body].join(
        "\r\n",
      ),
    );

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.secrets.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { raw } }),
    });

    if (!res.ok) {
      throw new Error(`Gmail create_draft failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as GmailDraftCreateResponse;
    return { draft_id: data.id, message_id: data.message.id };
  },
};

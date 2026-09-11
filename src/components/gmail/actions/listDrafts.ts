import { z } from "zod";
import type { ActionDefinition } from "../../../types";
import { describeGoogleApiError } from "../../../lib/googleErrors";

const input = z.object({
  max_results: z.number().int().min(1).max(50).default(10),
});

const draftSummary = z.object({
  draft_id: z.string(),
  message_id: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  snippet: z.string(),
});

const output = z.array(draftSummary);

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface GmailDraftListResponse {
  drafts?: { id: string; message: { id: string } }[];
}

interface GmailMessageGetResponse {
  id: string;
  snippet: string;
  payload: { headers: { name: string; value: string }[] };
}

function header(msg: GmailMessageGetResponse, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export const listDrafts: ActionDefinition<Input, Output> = {
  key: "list_drafts",
  description: "List unsent drafts in the connected Gmail account.",
  input,
  output,
  async run(connection, params) {
    if (!connection.secrets?.access_token) {
      throw new Error(`Connection ${connection.connection_id} has no access_token in secrets (not active yet?)`);
    }
    const authHeaders = { Authorization: `Bearer ${connection.secrets.access_token}` };

    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    listUrl.searchParams.set("maxResults", String(params.max_results));

    const listRes = await fetch(listUrl, { headers: authHeaders });
    if (!listRes.ok) {
      throw new Error(`Gmail list_drafts failed (${listRes.status}): ${await describeGoogleApiError(listRes)}`);
    }
    const { drafts = [] } = (await listRes.json()) as GmailDraftListResponse;

    // format=metadata, same reasoning as list_recent_emails: cheap N calls beat pulling full bodies for a
    // list view.
    const details = await Promise.all(
      drafts.map(async (d) => {
        const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${d.message.id}`);
        url.searchParams.set("format", "metadata");
        url.searchParams.append("metadataHeaders", "From");
        url.searchParams.append("metadataHeaders", "To");
        url.searchParams.append("metadataHeaders", "Subject");
        const res = await fetch(url, { headers: authHeaders });
        if (!res.ok) {
          throw new Error(`Gmail draft message fetch failed for ${d.message.id} (${res.status}): ${await describeGoogleApiError(res)}`);
        }
        const msg = (await res.json()) as GmailMessageGetResponse;
        return { draft_id: d.id, message_id: msg.id, from: header(msg, "From"), to: header(msg, "To"), subject: header(msg, "Subject"), snippet: msg.snippet };
      }),
    );

    return details;
  },
};

// Gmail App definition. Reference: docs/research/gmail-deep-dive.md, docs/research/other-platforms/pipedream.md.
// Kept deliberately small (Pipedream-style: few useful actions), not a 1:1 wrap of the Gmail API.

import type { AppDefinition } from "../../types";
import { config } from "../../config";
import { sendEmail } from "./actions/sendEmail";
import { listRecentEmails } from "./actions/listRecentEmails";
import { listLabels } from "./actions/listLabels";
import { getLabel } from "./actions/getLabel";
import { createLabel } from "./actions/createLabel";
import { updateLabel } from "./actions/updateLabel";
import { deleteLabel } from "./actions/deleteLabel";
import { createDraft } from "./actions/createDraft";
import { newEmail } from "./triggers/newEmail";
import { newLabeledEmail } from "./triggers/newLabeledEmail";
import { newSentEmail } from "./triggers/newSentEmail";
import { newStarredEmail } from "./triggers/newStarredEmail";
import { newDraft } from "./triggers/newDraft";

export const gmailApp: AppDefinition = {
  id: "gmail",
  name: "Gmail",
  auth: {
    type: "oauth2",
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    // TODO(ask): exact scope set — gmail-deep-dive.md notes gmail.readonly/gmail.modify/gmail.send/gmail.compose
    // depending on which actions ship. gmail.labels covers the label CRUD actions (list/get needs
    // readonly, but create/update/delete need the dedicated labels scope, not gmail.modify).
    // gmail.compose covers create_draft (drafts.create requires it, gmail.send alone isn't enough).
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
    client_id: config.apps.gmail.GMAIL_CLIENT_ID,
    client_secret: config.apps.gmail.GMAIL_CLIENT_SECRET,
    // Without these, Google only returns a refresh_token on the FIRST-ever authorization for a given
    // client_id+user — every subsequent re-connect silently omits it. access_type=offline requests one at
    // all; prompt=consent forces the consent screen (and a fresh refresh_token) every time.
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
  actions: [sendEmail, listRecentEmails, listLabels, getLabel, createLabel, updateLabel, deleteLabel, createDraft],
  // new_label (label creation) was removed — no real event exists for it anywhere, confirmed by
  // exhaustively checking Pipedream's actual 5 Gmail sources during R&D. new_labeled_email (a label being
  // applied to a message) replaces it — that one's real, verified against Pipedream's actual source.
  // new_sent_email/new_draft watch messageAdded + filter by the SENT/DRAFT system label (Gmail's history
  // API has no dedicated historyType for either); new_starred_email watches labelAdded + filters STARRED,
  // same technique as new_labeled_email. new_email_matching_search intentionally not added — it needs a
  // per-instance search query and src/api/trigger_routes.ts has no per-instance config field yet (same gap
  // new_labeled_email's per-label filter hit — see src/components/TODO.md).
  triggers: [newEmail, newLabeledEmail, newSentEmail, newStarredEmail, newDraft],
};

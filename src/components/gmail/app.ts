// Gmail App definition. Reference: docs/research/gmail-deep-dive.md, docs/research/other-platforms/pipedream.md.
// Kept deliberately small (Pipedream-style: few useful actions), not a 1:1 wrap of the Gmail API.

import type { AppDefinition } from "../../types";
import { config } from "../../config";
import { sendEmail } from "./actions/sendEmail";
import { listRecentEmails } from "./actions/listRecentEmails";
import { listSpamEmails } from "./actions/listSpamEmails";
import { getEmail } from "./actions/getEmail";
import { getCurrentUser } from "./actions/getCurrentUser";
import { listLabels } from "./actions/listLabels";
import { getLabel } from "./actions/getLabel";
import { createLabel } from "./actions/createLabel";
import { updateLabel } from "./actions/updateLabel";
import { deleteLabel } from "./actions/deleteLabel";
import { createDraft } from "./actions/createDraft";
import { listDrafts } from "./actions/listDrafts";
import { getDraft } from "./actions/getDraft";
import { updateDraft } from "./actions/updateDraft";
import { deleteDraft } from "./actions/deleteDraft";
import { sendDraft } from "./actions/sendDraft";
import { trashMessage } from "./actions/trashMessage";
import { untrashMessage } from "./actions/untrashMessage";
import { modifyMessageLabels } from "./actions/modifyMessageLabels";
import { getThread } from "./actions/getThread";
import { newEmailReceived } from "./triggers/newEmailReceived";
import { newEmailMatchingSearch } from "./triggers/newEmailMatchingSearch";
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
    // gmail.labels covers the label CRUD actions (list/get needs readonly, but create/update/delete need
    // the dedicated labels scope, not gmail.modify). gmail.compose covers every drafts.* endpoint
    // (create/get/list/update/delete/send). gmail.modify covers messages.trash/untrash/modify — added for
    // trash_message/untrash_message/modify_message_labels; a connection authorized before these actions
    // shipped needs to be reconnected once to pick up this scope, same as any new-scope addition.
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    client_id: config.apps.gmail.GMAIL_CLIENT_ID,
    client_secret: config.apps.gmail.GMAIL_CLIENT_SECRET,
    // Without these, Google only returns a refresh_token on the FIRST-ever authorization for a given
    // client_id+user — every subsequent re-connect silently omits it. access_type=offline requests one at
    // all; prompt=consent forces the consent screen (and a fresh refresh_token) every time.
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
  actions: [
    sendEmail,
    listRecentEmails,
    listSpamEmails,
    getEmail,
    getThread,
    getCurrentUser,
    listLabels,
    getLabel,
    createLabel,
    updateLabel,
    deleteLabel,
    createDraft,
    listDrafts,
    getDraft,
    updateDraft,
    deleteDraft,
    sendDraft,
    trashMessage,
    untrashMessage,
    modifyMessageLabels,
  ],
  // new_label (label creation) was removed — no real event exists for it anywhere, confirmed by
  // exhaustively checking Pipedream's actual 5 Gmail sources during R&D.
  // new_sent_email/new_draft watch messageAdded + filter by the SENT/DRAFT system label (Gmail's history
  // API has no dedicated historyType for either); new_starred_email watches labelAdded + filters STARRED;
  // new_email_received requires INBOX (see newEmailReceived.ts). new_email_matching_search is now
  // implemented too, on a deliberately different mechanism (messages.list + q + a timestamp cursor, not
  // history.list — see newEmailMatchingSearch.ts's header comment for why) now that trigger_routes.ts's
  // generic per-instance `config` plumbing reaches poll() (types.ts's TriggerDefinition.poll third param),
  // closing the gap this comment used to describe.
  // new_labeled_email (fire on ANY label being applied, not just STARRED) was removed — see PHASES.md's
  // TODO: it's effectively a superset of new_email_received with no per-instance label filter to narrow it,
  // so every subscriber got every label change on every message, most of which duplicate what
  // new_email_received/new_starred_email already report.
  triggers: [newEmailReceived, newEmailMatchingSearch, newSentEmail, newStarredEmail, newDraft],
};

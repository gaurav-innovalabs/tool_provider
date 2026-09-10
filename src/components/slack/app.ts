// Slack App definition. Same shape as gmail/app.ts. .env.example already has SLACK_CLIENT_ID/SECRET.
//
// API reference:
//   https://docs.slack.dev/authentication/installing-with-oauth (authorize_url + `scope`/`user_scope` split)
//   https://docs.slack.dev/reference/methods/oauth.v2.access (token_url; response includes both the bot
//     `access_token` and the nested `authed_user.access_token` — see lib/oauth.ts's exchangeCodeForToken)

import type { AppDefinition } from "../../types";
import { config } from "../../config";
import { postMessage } from "./actions/postMessage";
import { listChannels } from "./actions/listChannels";
import { sendDirectMessage } from "./actions/sendDirectMessage";
import { updateMessage } from "./actions/updateMessage";
import { deleteMessage } from "./actions/deleteMessage";
import { addReaction } from "./actions/addReaction";
import { removeReaction } from "./actions/removeReaction";
import { createChannel } from "./actions/createChannel";
import { archiveChannel } from "./actions/archiveChannel";
import { joinChannel } from "./actions/joinChannel";
import { inviteUserToChannel } from "./actions/inviteUserToChannel";
import { setChannelTopic } from "./actions/setChannelTopic";
import { listUsers } from "./actions/listUsers";
import { findUserByEmail } from "./actions/findUserByEmail";
import { uploadFile } from "./actions/uploadFile";
import { findMessages } from "./actions/findMessages";
import { getChannelHistory } from "./actions/getChannelHistory";
import { getThreadReplies } from "./actions/getThreadReplies";
import { getChannelDetails } from "./actions/getChannelDetails";
import { getUserDetails } from "./actions/getUserDetails";
import { getCurrentUser } from "./actions/getCurrentUser";
import { newMessage } from "./triggers/newMessage";
import { messageEdited } from "./triggers/messageEdited";
import { messageDeleted } from "./triggers/messageDeleted";
import { reactionAdded } from "./triggers/reactionAdded";
import { reactionRemoved } from "./triggers/reactionRemoved";
import { userJoinedChannel } from "./triggers/userJoinedChannel";
import { channelCreated } from "./triggers/channelCreated";
import { fileShared } from "./triggers/fileShared";
import { handleSlackEventsWebhook } from "./webhooks/events";

export const slackApp: AppDefinition = {
  id: "slack",
  name: "Slack",
  auth: {
    type: "oauth2",
    authorize_url: "https://slack.com/oauth/v2/authorize",
    token_url: "https://slack.com/api/oauth.v2.access",
    // One scope per action family, same "only add when an action needs it" rule as before. These are all
    // BOT scopes (`scope`, granted to the bot token / xoxb) — see extraAuthorizeParams below for the
    // separate USER scopes (`user_scope`, granted to authed_user.access_token / xoxp).
    // chat:write        - post_message, send_direct_message, update_message, delete_message (as bot, default)
    // chat:write.public - lets the bot post_message/update_message/delete_message to a PUBLIC channel it
    //                     hasn't been invited/joined into yet — without this, chat.postMessage rejects with
    //                     "not_in_channel" for any public channel the bot isn't already a member of, which
    //                     is a hard blocker for a new connection posting to any channel that wasn't manually
    //                     /invite'd first. Private channels still require an explicit invite regardless —
    //                     this scope only covers public ones (per Slack's own docs).
    // im:write          - send_direct_message (conversations.open)
    // channels:read     - list_channels
    // channels:manage   - create_channel, archive_channel, invite_user_to_channel, set_channel_topic
    // channels:join     - join_channel (conversations.join — a real, distinct scope from channels:manage
    //                     above, confirmed against a live 403 missing_scope when it was missing here).
    //                     Required for the bot to actually RECEIVE events from a public channel;
    //                     chat:write.public above only covers posting there, a separate permission from
    //                     receiving events — see joinChannel.ts's header comment for the full story.
    // reactions:write   - add_reaction, remove_reaction
    // users:read        - list_users, find_user_by_email
    // users:read.email  - find_user_by_email (users.lookupByEmail needs the email-specific scope too)
    // files:write       - upload_file
    // channels:history  - get_channel_history, get_thread_replies (conversations.history/.replies)
    // get_channel_details (conversations.info), get_user_details (users.info), get_current_user (auth.test)
    // need no new scope — channels:read/users:read already cover them, auth.test needs none at all.
    // reactions:read    - EVENT scope for reaction_added/reaction_removed triggers (distinct from
    //                     reactions:write above, which is for the add_reaction/remove_reaction actions).
    // channels:read     - also covers the member_joined_channel/channel_created event triggers below, no
    //                     extra scope needed beyond what list_channels already required.
    // files:read        - EVENT scope for the file_shared trigger (distinct from files:write above, which
    //                     is for the upload_file action — Slack splits file read/write the same way it
    //                     splits reactions:read/reactions:write).
    scopes: [
      "chat:write",
      "chat:write.public",
      "im:write",
      "channels:read",
      "channels:manage",
      "channels:join",
      "reactions:write",
      "reactions:read",
      "users:read",
      "users:read.email",
      "files:write",
      "files:read",
      "channels:history",
    ],
    client_id: config.apps.slack.SLACK_CLIENT_ID,
    client_secret: config.apps.slack.SLACK_CLIENT_SECRET,
    // Slack-specific v2 OAuth param requesting a SECOND token — the user's own (authed_user.access_token,
    // captured by lib/oauth.ts's exchangeCodeForToken into secrets.user_access_token). Two things need it
    // and only it, a bot token cannot do either: `as_user: true` on the message actions (posting/editing/
    // deleting AS the authorizing human, not as the bot) needs chat:write here; find_messages
    // (search.messages) needs search:read — that Slack Web API method flatly rejects bot tokens.
    extraAuthorizeParams: { user_scope: "chat:write,search:read" },
  },
  actions: [
    postMessage,
    listChannels,
    sendDirectMessage,
    updateMessage,
    deleteMessage,
    addReaction,
    removeReaction,
    createChannel,
    archiveChannel,
    joinChannel,
    inviteUserToChannel,
    setChannelTopic,
    listUsers,
    findUserByEmail,
    uploadFile,
    findMessages,
    getChannelHistory,
    getThreadReplies,
    getChannelDetails,
    getUserDetails,
    getCurrentUser,
  ],
  triggers: [newMessage, messageEdited, messageDeleted, reactionAdded, reactionRemoved, userJoinedChannel, channelCreated, fileShared],
  // ---------------------------------------------------------------------------------------------------
  // Webhooks — how a webhook-mode trigger (the eight above, every one of them) actually receives events.
  // ---------------------------------------------------------------------------------------------------
  // Real-time delivery for Slack is ONE inbound HTTP endpoint, registered ONCE in Slack's own app config
  // (Event Subscriptions -> Request URL, see .env.example's SLACK_SIGNING_SECRET comment for the exact
  // click-path + which bot events to subscribe to), not one URL per trigger/connection/instance:
  //
  //   Slack  --POST-->  {BASE_URL}/webhooks/slack/events
  //                              |
  //                              v
  //   src/api/webhook_routes.ts's generic "/webhooks/:app/:hook" route: looks up `app` via the registry
  //   (getApp("slack") -> this file), then looks up `app.webhooks["events"]` below, and hands it the raw,
  //   UNPARSED Request. That router has zero Slack-specific knowledge — no signature verification, no
  //   event-shape parsing — it is purely `app.webhooks[hook](req)` or a 404 if either `app` or `hook` isn't
  //   registered. This is the SAME generic path every future app's webhook goes through.
  //                              |
  //                              v
  //   ./webhooks/events.ts's handleSlackEventsWebhook(req) does everything Slack-specific: verifies
  //   x-slack-signature/x-slack-request-timestamp against SLACK_SIGNING_SECRET (src/lib/slackSignature.ts),
  //   answers Slack's one-time url_verification handshake, maps the raw event's (type, subtype) to one of
  //   the eight TriggerDefinition.key values above (resolveTriggerKey — this is the one place that knows
  //   e.g. a `message` event with subtype "message_changed" means message_edited, not new_message), then
  //   fans the normalized event out to every active TriggerInstance subscribed to that trigger key
  //   (POST /triggers/slack/:trigger/subscribe — src/api/trigger_routes.ts), via the same deliverEvent()
  //   src/core/scheduler.ts's poll cycle uses for Gmail. Same envelope shape reaches a subscriber's
  //   webhook_url either way — a caller can't tell poll vs. webhook apart from the delivered payload.
  //
  // Scaling to a new app with its OWN webhook shape (Gmail push via Cloud Pub/Sub, Stripe, anything):
  // add src/components/<app>/webhooks/<hook>.ts with the same `(req: Request) => Promise<Response>` shape,
  // register it as `webhooks: { <hook>: handler }` on that app's AppDefinition (types.ts documents the
  // field), and register {BASE_URL}/webhooks/<app>/<hook> with that provider. webhook_routes.ts itself
  // never changes — no per-app branch to add, no route to register by hand. An app with only poll-mode
  // triggers (Gmail today) simply omits `webhooks` entirely; POST /webhooks/gmail/anything 404s cleanly.
  webhooks: {
    events: handleSlackEventsWebhook,
  },
};

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
    // groups:write       - create_channel(is_private: true) — createChannel.ts's own comment already
    //                     flagged this 403 missing_scope gap; closed here.
    //
    // ---------------------------------------------------------------------------------------------------
    // Bot scopes vs. user scopes — what's still bot-scoped and why, per
    // TRIGGER_USER_SCOPED_REFACTOR.md (2026-09-10): Pipedream's real, verified behavior is that TRIGGERS
    // (event receipt) run on USER-scoped Events API delivery ("Subscribe to events on behalf of users"),
    // not bot-scoped — Slack delivers everything the connecting human can already see, with NO requirement
    // that the bot itself be a member of the channel. Verified live: Pipedream's own trigger fired from a
    // channel with zero Pipedream bot in conversations.members. Confirmed via Slack's own docs
    // (docs.slack.dev/apis/events-api/, "you will only receive events that users who've authorized your
    // app can 'see' on their workspace") that this is a real, current, fully-supported delivery mode — not
    // a legacy artifact or a hack.
    //
    // So: reactions:read, channels:history, groups:read, groups:history, im:read, im:history, mpim:read,
    // mpim:history, files:read above are BOT scopes that exist ONLY because they used to double as event
    // scopes under bot-scoped delivery — they're KEPT here because get_channel_history/get_thread_replies
    // (channels:history) and other read ACTIONS still use the bot token and still need them for that. What
    // moved is event DELIVERY itself: triggers now subscribe via user_scope below, not via these.
    // channels:join is REMOVED (2026-09-10): its only purpose was letting the bot self-join a channel so
    // it could receive events under the old bot-scoped model — with triggers now user-scoped, that need is
    // gone, and nothing else used conversations.join, so the join_channel action was deleted along with it.
    scopes: [
      "chat:write",
      "chat:write.public",
      "im:write",
      "channels:read",
      "channels:manage",
      "reactions:write",
      "reactions:read",
      "users:read",
      "users:read.email",
      "files:write",
      "files:read",
      "channels:history",
      "groups:read",
      "groups:history",
      "groups:write",
      "im:read",
      "im:history",
      "mpim:read",
      "mpim:history",
    ],
    client_id: config.apps.slack.SLACK_CLIENT_ID,
    client_secret: config.apps.slack.SLACK_CLIENT_SECRET,
    // Slack-specific v2 OAuth param requesting a SECOND token — the user's own (authed_user.access_token,
    // captured by lib/oauth.ts's exchangeCodeForToken into secrets.user_access_token). USER scopes here
    // cover two distinct needs:
    //   chat:write, search:read       - as_user:true message actions + find_messages (search.messages
    //                                   flatly rejects bot tokens) — unrelated to triggers, pre-existing.
    //   channels:history, groups:history, im:history, mpim:history, reactions:read (+ paired :read scopes
    //   channels:read, groups:read, im:read, mpim:read) - EVENT delivery for every Slack trigger
    //   (new_message, reaction_added, etc.), added 2026-09-10 per TRIGGER_USER_SCOPED_REFACTOR.md. This is
    //   what actually makes triggers user-scoped instead of bot-scoped: Slack's Event Subscriptions page
    //   has a SEPARATE "Subscribe to events on behalf of users" section (distinct from "Subscribe to bot
    //   events") — the 9 event types need to be added THERE, not (only) under bot events, for this
    //   user_scope grant to actually deliver anything. See .env.example for the click-path.
    extraAuthorizeParams: {
      user_scope:
        "chat:write,search:read,channels:history,groups:history,im:history,mpim:history,reactions:read,channels:read,groups:read,im:read,mpim:read",
    },
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

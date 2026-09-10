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
    scopes: [
      "chat:write",
      "im:write",
      "channels:read",
      "channels:manage",
      "reactions:write",
      "users:read",
      "users:read.email",
      "files:write",
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
  triggers: [newMessage],
};

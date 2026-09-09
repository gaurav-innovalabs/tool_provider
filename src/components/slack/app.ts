// Slack App definition. Same shape as gmail/app.ts. .env.example already has SLACK_CLIENT_ID/SECRET.

import type { AppDefinition } from "../../types";
import { config } from "../../config";
import { postMessage } from "./actions/postMessage";
import { listChannels } from "./actions/listChannels";
import { newMessage } from "./triggers/newMessage";

export const slackApp: AppDefinition = {
  id: "slack",
  name: "Slack",
  auth: {
    type: "oauth2",
    authorize_url: "https://slack.com/oauth/v2/authorize",
    token_url: "https://slack.com/api/oauth.v2.access",
    // TODO(ask): exact scope set — chat:write + channels:read covers postMessage/listChannels; add more
    // only when an action needs it (channels:history if newMessage ends up polling instead of webhook).
    scopes: ["chat:write", "channels:read"],
    client_id: config.apps.slack.SLACK_CLIENT_ID,
    client_secret: config.apps.slack.SLACK_CLIENT_SECRET,
  },
  actions: [postMessage, listChannels],
  triggers: [newMessage],
};

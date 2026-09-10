// Slack's Web API returns a terse machine code in `error` (e.g. "cant_delete_message") with NO human
// explanation — every action here used to surface that raw code verbatim ("Slack delete_message failed:
// cant_delete_message"), which tells a caller THAT it failed but not WHY or what to do about it. This maps
// the codes actually reachable from this app's own action set (per https://docs.slack.dev/reference/methods/
// — each method page lists its own possible `error` values) to a one-line explanation + fix, appended after
// the raw code so both the machine-readable value and the human one are visible. Unknown/unmapped codes
// still pass through unchanged — never fabricate an explanation for a code not looked up from real docs.
const SLACK_ERROR_EXPLANATIONS: Record<string, string> = {
  channel_not_found:
    "no channel with that ID (or you passed a #name instead of a real channel ID — most actions here require the ID, see e.g. update_message's channel_id field; post_message is the one exception that accepts a name).",
  not_in_channel:
    "the bot isn't a member of this channel — either /invite it in Slack, or add the chat:write.public bot scope (public channels only) and reconnect.",
  is_archived: "this channel is archived — unarchive it first, or use a different channel.",
  already_archived: "this channel is already archived.",
  name_taken: "a channel with this name already exists in the workspace.",
  msg_too_long: "the message text is over Slack's length limit.",
  cant_update_message:
    "the identity calling this doesn't match how the message was originally posted — retry with the same as_user value (true/false) used on the original post_message call.",
  cant_delete_message:
    "the identity calling this doesn't match how the message was originally posted (a bot token can only delete its own bot-posted messages) — retry with the same as_user value used on the original post_message call.",
  message_not_found: "no message found for that channel_id + ts combination — double-check ts came from this exact channel.",
  already_reacted: "this emoji reaction is already on the message from this identity.",
  no_reaction: "this emoji reaction isn't currently on the message, so it can't be removed.",
  not_allowed_token_type:
    "this Slack method requires a USER token, not a bot token — the connection needs the search:read/chat:write user scope granted at OAuth time (see app.ts's extraAuthorizeParams); reconnect if it wasn't.",
  missing_scope:
    "the stored token is missing a required OAuth scope — check .env.example's Bot/User Token Scopes list, add the missing one in Slack's app config, then reconnect (a scope change needs a fresh OAuth grant).",
  invalid_auth: "the stored access token is invalid — reconnect this Slack connection (POST /connections).",
  token_revoked: "the stored access token was revoked (e.g. the app was uninstalled from the workspace) — reconnect.",
  account_inactive: "the Slack account behind this token was deactivated — reconnect with a different account.",
  ratelimited: "Slack rate-limited this request — wait a moment and retry.",
  users_not_found: "no Slack user in this workspace matches that email.",
  restricted_action: "a workspace admin has restricted this action (e.g. posting to this channel) for this token's role.",
  cant_invite_self: "you can't invite the connected app's own bot user to a channel via invite_user_to_channel.",
  already_in_channel: "one or more of these users are already members of the channel.",
};

// Appends a human explanation after Slack's raw error code — e.g. "cant_delete_message (the identity
// calling this doesn't match how the message was originally posted — retry with the same as_user value
// used on the original post_message call.)". The raw code is always kept, never replaced — a caller
// programmatically checking `error.includes("cant_delete_message")` still works exactly as before.
export function describeSlackError(rawError: string): string {
  const explanation = SLACK_ERROR_EXPLANATIONS[rawError];
  return explanation ? `${rawError} (${explanation})` : rawError;
}

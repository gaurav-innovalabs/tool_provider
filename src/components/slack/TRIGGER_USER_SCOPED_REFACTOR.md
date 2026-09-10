# Slack triggers → user-scoped events refactor

**Status (2026-09-10):** TODOs 1, 2, 4, 5 done (code-level: app.ts's `scopes`/`user_scope`, .env.example,
`channels:join` removed, `join_channel` action deleted — decided by the user: delete, not keep as a
utility). `bunx tsc --noEmit` and `bun test` both clean after every change.

TODO 3 is resolved by code inspection (no live Slack connection available in this environment to prove it
end to end, but the reasoning is conclusive, not a guess): `events.ts` never branches on bot- vs
user-scoped delivery anywhere —
- signature verification (`verifySlackSignature`) checks the app-level signing secret, same for both modes.
- `resolveTriggerKey` dispatches purely on `event.type`/`event.subtype`, which Slack sends identically
  either way.
- connection lookup keys on `body.team_id` against `connection.secrets.team_id`, captured once at OAuth
  install time — unaffected by which token (bot or user) the event arrived attributed to.
- the bot/own-message filter (`event.subtype === "bot_message" || event.bot_id`) filters messages a bot
  AUTHORED, unrelated to which grant DELIVERED the event to us.
So: genuinely zero code changes needed for the switch itself, confirmed by reading every branch in the
file, not assumed. The `authorizations` array was deliberately NOT touched, per this doc's own instruction
not to add speculative handling for a field with no proven need.

TODO 6 is the one item that **cannot be completed from here** — it requires a real browser-driven Slack
OAuth consent screen (reconnecting `POST /connections` -> the returned `connect_url`) against your actual
Slack workspace, then reacting to/posting in a channel the bot was deliberately never invited to, and
watching `trigger_logs`/server console for delivery. No credential or tool available in this session can
do that; it needs you. TODO 7's PHASES.md entry has now been added, but marked "live verification pending"
rather than fully done, per this doc's own "don't claim done on a green build alone" rule — flip it to
fully DONE once you've run TODO 6 and confirmed it works.

**What you need to do to finish this, in order:**
1. In your Slack app config (api.slack.com/apps), add the 11 User Token Scopes and move the 9 event
   subscriptions to "Subscribe to events on behalf of users" — exact list in `.env.example`.
2. Reconnect: `POST /connections {"app": "slack", ...}` -> open the returned `connect_url` -> approve.
3. Pick a channel your bot was never added to (check via `GET_CHANNEL_DETAILS`'s `is_member: false`).
   React to (or post in) a message there and watch `trigger_logs`/server console — a delivered event with
   no join/invite step proves the refactor works, exactly matching Pipedream's real behavior.

This is a planning doc, split into independent TODOs so separate sessions/agents can pick items up and work
in parallel. Read the whole "Context" section before touching any TODO — the scope of what changes (and
what deliberately doesn't) matters here.

**Governing rule for this refactor (explicit user direction, not a default to re-derive each time): for
Slack TRIGGERS specifically, strictly follow Pipedream's real approach — no independent design, no
alternative mechanism, no "we know a cleaner way." If Pipedream's actual behavior/scope model (verified via
real source/docs, per the Context section below) says user-scoped events with no bot-membership
requirement, that is what gets built, exactly that, nothing else layered on top or substituted in. This
applies to every TODO below and to any follow-on trigger work this doc doesn't already cover.**

## Context — why this refactor, and what was actually verified (not guessed)

Every trigger we built (`new_message`, `reaction_added`, etc.) currently relies on Slack's **bot-scoped**
Events API delivery: `Subscribe to bot events` (Bot Token Scopes: `channels:history`, `groups:history`,
`im:history`, `mpim:history`, `reactions:read`, ...). This is Slack's documented, current, standard model —
but it has one hard requirement: **the bot must be an actual member of a channel before Slack will deliver
`message.channels`/`reaction_added`/etc. events from it.** For public channels our `channels:join` scope +
`join_channel` action cover this; private channels/DMs need an explicit human invite/opened conversation.

The user compared this against Pipedream, whose `new-message-in-channels` trigger received a real message
from channel `C0772SYKNN4` with **no bot ever added to that channel** (verified live —
`conversations.members` on that channel, called with our own bot's token, lists 8 real members: 2 humans
+ 6 bots — `jirabot`, `claude` (this app), `activecaptain`, `gumloop`, `deskferry2`, `demo_app` (this app,
again — the OAuth app is literally named "Demo App"). **No Pipedream bot anywhere in that list.**

Two candidate explanations were checked, not assumed:

1. **Legacy "classic bot" auto-join-all-public-channels.** Real Slack behavior, once — a `bot` scope on a
   pre-2021 "classic app" got auto-added to every public channel workspace-wide as a platform side effect.
   **Ruled out**: Slack fully deprecated legacy workspace apps in 2021 and legacy custom bots as of
   2025-03-31 (confirmed via Slack's own docs — `api.slack.com/legacy/enabling-bot-users`,
   `docs.slack.dev/authentication/tokens/`). Not available to any app today, Pipedream included, and even if
   it were, Pipedream's bot would appear in the member list above — it doesn't.
2. **"Subscribe to events on behalf of users"** — Slack's *other* Events API delivery mode, gated by
   `user_scope` (the authorizing human's own OAuth grant) instead of the bot's. Per Slack's own docs
   (`docs.slack.dev/apis/events-api/`, corroborated by `medium.com/slack-developer-blog/subscribe-to-the-
   events-api-d7120470983f`): *"you will only receive events that users who've authorized your app can
   'see' on their workspace"* — **no bot channel membership required at all**, because the event isn't
   scoped to the bot's presence, it's scoped to what the connecting human can already see. This is
   consistent with every piece of evidence above (Pipedream's bot absent from the member list, event still
   delivered) and is a real, current, fully-supported Slack feature — not a legacy artifact, not a trick.

**Decision (per explicit user direction — "do trigger like pipedream always ok nothing different"):**
switch our Slack triggers from bot-scoped to **user-scoped** event delivery. This removes the
join-channel/invite requirement entirely for triggers, matching Pipedream's actual behavior on the nose,
using a real standard Slack mechanism (not a hack).

**What this trades away, so it's a deliberate choice, not a silent side effect:** user-scoped events see
*everything the connecting human has access to* — every channel/DM/group-DM they're personally in, whether
or not this app was ever meant to touch it. That's broader than the current bot-scoped model. This was
already surfaced to the user as the real trade-off before this doc was written; proceeding anyway is their
call, not an oversight.

**What does NOT change:** every *action* (`post_message`, `add_reaction`, `get_channel_history`, ...) still
uses the **bot token** exactly as today — this refactor is scoped to event *receipt* only. Bot Token Scopes
needed purely for actions (`channels:history` for `get_channel_history`, `reactions:write` for
`add_reaction`, etc.) are NOT touched. Only the scopes/mechanism that exist *solely* for triggering events
are in scope here.

## Reference material (read before implementing)

- Slack Events API docs: https://docs.slack.dev/apis/events-api/
- Slack's own bot-vs-user-events explainer: https://medium.com/slack-developer-blog/subscribe-to-the-events-api-d7120470983f
- `src/components/slack/app.ts` — current `scopes`/`extraAuthorizeParams` (bot + user scope split already
  exists here for `chat:write`/`search:read` — the pattern to extend, not invent)
- `src/lib/oauth.ts` — `buildAuthorizeUrl()`-equivalent logic; confirms `scope` (bot) and `user_scope`
  params are both already wired end-to-end, just need more values added to `user_scope`
- `src/components/slack/webhooks/events.ts` — the inbound handler; **the event envelope Slack POSTs is the
  same shape regardless of bot- or user-scoped delivery** — this file's parsing/dispatch logic should need
  **no changes** for the switch itself (see TODO 3 for the one thing worth checking: the `authorizations`
  array, to correctly attribute which grant an event came through, for dedup/logging clarity only)
- `src/components/slack/actions/joinChannel.ts` — its header comment states its ENTIRE purpose was "bot
  needs to be a member to receive events" — that purpose goes away under this refactor (see TODO 5)

## TODOs — independent, can be parallelized across sessions

### TODO 1 — Add user-scope event permissions to OAuth (`src/components/slack/app.ts`)
Extend `extraAuthorizeParams.user_scope` (currently `"chat:write,search:read"`) to also request the
USER-scope equivalents of what's currently bot-scoped purely for event delivery:
`channels:history,groups:history,im:history,mpim:history,reactions:read` (+ the paired `:read` scopes —
`channels:read,groups:read,im:read,mpim:read` — check Slack's scopes reference for whether these are
required alongside `:history` for a user grant, same as the bot-scope pairing already documented in this
file's comments). Update the big comment block above `scopes:` to document this split clearly: which
scopes exist for actions (bot-scoped, staying), which exist for triggers (moving to user-scoped).
**Depends on nothing. Safe to do first/independently.**

### TODO 2 — Update `.env.example`'s Slack setup instructions
The current step-by-step ("Bot Token Scopes, add all 20...") needs a new section: **User Token Scopes**
(separate from the existing "Bot Token Scopes" list) with the scopes from TODO 1, and — critically — a
walkthrough of Slack's **"Subscribe to events on behalf of users"** section in Event Subscriptions (this
session confirmed the user's app currently has this section empty/"none" — it needs the same 9 event types
currently under "Subscribe to bot events", added there instead, or in addition). Cross-reference: this
session's transcript has the user's actual pasted "Subscribe to bot events" list to model the new section's
docs on. Also update/remove the existing "chat:write.public... bot isn't a member" and "channels:join...
required for bot to RECEIVE events" troubleshooting notes — those become stale/wrong once triggers no
longer need bot membership. **Depends on TODO 1 being decided (same scope list).**

### TODO 3 — Verify `events.ts` handles a user-authorized event with no behavior change needed (or fix it)
Confirm live (once TODO 1/2's Slack-side config is in place and reconnected) that a user-scoped delivery
actually parses/dispatches/delivers correctly through the EXISTING code path with zero changes — the
working theory (see Reference material) is that it should, since the envelope shape is identical. If true,
this TODO is "confirmed, no code change" — document that finding here. If the `authorizations` array (new
Slack event envelope field, not currently read anywhere in `events.ts`) turns out to matter for correctly
attributing an event to the right connection/token, add reading it, but only if live testing shows it's
actually needed — don't add speculative handling for a field that turns out to be unnecessary.
**Depends on TODO 1 + a real reconnect through the new OAuth scopes.**

### TODO 4 — Remove `channels:join` bot scope (event-purpose only, not action-purpose)
Per `join_channel.ts`'s own header comment, `channels:join` bot scope was added SOLELY so the bot could
self-join public channels to receive their events. Once TODO 1-3 land and triggers no longer need bot
membership, re-examine whether this scope has any other use — it doesn't appear to (nothing else in
`src/components/slack/actions/*.ts` calls `conversations.join`). If confirmed unused elsewhere, remove
`channels:join` from `app.ts`'s bot `scopes` array and update its removal in every place it's documented
(`.env.example`, this file's own comments, `app.ts`'s scope-list comment block).
**Depends on TODO 3 confirming triggers genuinely work without it — don't remove until proven, not just assumed.**

### TODO 5 — Decide the fate of the `join_channel` action + `SLACK_JOIN_CHANNEL` tool
`src/components/slack/actions/joinChannel.ts` exists entirely for the now-obsolete "bot needs to join to
receive events" reason. Once TODO 4 lands, decide: (a) delete the action entirely (mirrors what was done
for Gmail's `new_labeled_email` earlier this session — a real precedent for removing something once its
reason for existing goes away — see `PHASES.md`'s Phase 3 section for that writeup's shape/tone to match),
or (b) keep it as a general-purpose utility action independent of triggers (a caller might still want the
bot to literally post/react in a channel as itself, which still needs bot membership regardless of the
event-delivery mechanism). **This is a judgment call, not a mechanical follow-on — flag it back to the user
rather than deciding unilaterally.** Update `src/components/slack/app.ts`'s `actions` array,
`test_components/slack/*.test.ts`, and `test_components/slack/slack.http` to match whichever way this goes.
**Depends on TODO 4.**

### TODO 6 — Full re-verification pass (mirrors this session's diagnostic method, don't skip)
Once TODO 1-5 land: typecheck (`bunx tsc --noEmit`), `bun test`, then a REAL live test — reconnect through
the new OAuth scopes, react to a message in a channel the bot was deliberately NOT added to, and confirm
via `trigger_logs`/server console that the event arrives and delivers. This is the actual proof the
refactor achieved its goal (matching Pipedream's no-join-needed behavior) — don't mark this refactor done
on a green typecheck/test run alone, the same way "it compiles" was never sufficient evidence anywhere else
in this session's diagnostic work. **Depends on all above.**

### TODO 7 — Update `PHASES.md` once TODO 1-6 are all done
Add a dated entry (Phase 3 section, same style as every other entry there) summarizing: what changed, why
(link back to this file, then this file can be deleted/archived once superseded by the PHASES.md entry —
same lifecycle as how other scratch/planning docs in this repo get folded into PHASES.md once work lands).
**Depends on everything above being actually done, not just planned.**

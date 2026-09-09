# Architecture (pseudo-code phase)

Reference: `../research/` (auth-patterns.md, triggers-patterns.md, gmail-deep-dive.md, comparison.md). This doc is the terminology + flow contract that all `src/` skeleton files follow. See `PHASES.md` for what's real vs stubbed right now.

## Terminology

- **App** — a third-party service definition. e.g. `gmail`, `slack`. Declares: id, display name, auth type, OAuth scopes/endpoints, its list of Actions, its list of Triggers. Lives in `src/components/<app>/app.ts` — "components" naming taken from Pipedream (see `src/components/TODO.md` for the structural R&D on this).
- **Action** — one callable "tool" a caller/agent can invoke against a Connection. e.g. `gmail.send_email`, `slack.post_message`. Small input schema, one `run(connection, input)` function. Deliberately kept few-and-useful per app (Pipedream-style), not an exhaustive 1:1 wrap of the entire third-party API (Composio-style).
- **Trigger** — an event source definition. e.g. `gmail.new_email`, `slack.new_message`. Either `poll` (we call the API on an interval, diff since a stored cursor) or `webhook` (third party pushes to us). See `research/triggers-patterns.md`.
- **User** — our internal identity for whoever the client is acting on behalf of. Created via `createUser`, holds an opaque `user_metadata` blob the client passed at creation time — we don't interpret it, just store and return it.
- **Connection** — the result of a completed OAuth flow: one `user_id` + one `app`, holding the credential. Identified by `connection_id`. This is what every Action/Trigger call is scoped to.

## Flow (Phase 1 scope: Gmail + Slack only, env-based shared OAuth app)

```
1. Client -> createUser({ metadata })
   Server  -> stores { user_id, user_metadata: metadata }  (opaque, no validation)
   Server  -> returns { user_id }

2. Client -> requestConnection({ user_id, app: "gmail" })
   Server  -> looks up gmail's App definition + OAuth client id/secret from .env
   Server  -> builds authorize_url (state = connection_id, freshly generated, status="pending")
   Server  -> returns { connection_id, authorize_url }

3. (out of band) user visits authorize_url, approves, provider redirects to:
   GET /oauth/callback/:app?code=...&state=<connection_id>
   Server  -> exchanges code for tokens via the App's OAuth config
   Server  -> stores tokens on the connection row, status="active"
   Server  -> redirects/responds per TODO in src/lib/oauth.ts

4. Client -> POST /actions/:app/:actionKey { connection_id, input }
   Server  -> loads connection by connection_id, loads its credential
   Server  -> looks up the App's Action by actionKey, calls run(connection, input)
   Server  -> returns the Action's result

5. (Phase 3) Client -> POST /triggers/:app/:triggerKey/subscribe { connection_id, ...delivery config }
   Server  -> creates a trigger_instance, scheduler picks it up on its poll interval
   Server  -> on new event, delivers to caller (delivery shape: TODO, see PHASES.md Phase 6)
```

## Why `user` and `connection` are separate

A `user_id` can end up with multiple `connection_id`s (Gmail *and* Slack, or two Gmail accounts later) — metadata about *who this is* lives once on the user; the OAuth credential + its status lives per connection. This mirrors the Auth Config / Connected Account split in `research/auth-patterns.md` #1, simplified for Phase 1 (no Auth Config table yet since we're not supporting bring-your-own OAuth app until Phase 5 — the "Auth Config" for now is just the app's `.env` entry).

## File map (Phase 1)

```
src/
  types.ts          # App, Action, Trigger, User, Connection shapes — the contract every app.ts follows
  core/
    store.ts         # in-memory store for users/connections (Phase 1 only, see TODO)
    registry.ts        # App registry: id -> App definition (gmail, slack)
    # Only domain-shaped logic lives here. No users.ts/connections.ts/admin.ts (that logic lives
    # directly in the matching src/api/*_routes.ts file, the only caller of each) and no generic
    # infra clients (those are src/lib/, see below) — "core" == the domain model + its persistence,
    # nothing else.
  lib/
    oauth.ts           # buildAuthorizeUrl, exchangeCodeForToken — generic OAuth2, reads per-app env creds
    postgres.ts          # Postgres client (Bun.sql) — Phase 4, not wired yet
    redis.ts               # Redis client (Bun.redis) — Phase 4, not wired yet
    s3.ts                    # S3 client (Bun.s3) — Phase 4, not wired yet, use unconfirmed
  db/
    schema.ts           # Drizzle schema (source of truth for `bun run db:generate`) — see MIGRATIONS.md
    migrations/            # generated SQL + drizzle-kit's snapshot/journal metadata
  components/
    TODO.md                # R&D: how component structure should look as this scales (Pipedream/Composio/Activepieces compared)
    gmail/
      app.ts               # Gmail App definition (auth config + action/trigger list)
      actions/
        sendEmail.ts         # stub, Phase 2
        listRecentEmails.ts    # stub, Phase 2
      triggers/
        newEmail.ts             # stub, Phase 3 — historyId-based polling per gmail-deep-dive.md
    slack/
      app.ts
      actions/
        postMessage.ts
        listChannels.ts
      triggers/
        newMessage.ts            # stub, Phase 3 — TODO(ask): poll vs Slack Events API webhook
  api/
    admin_routes.ts                # GET /admin/users, /admin/triggers, /admin/logs — read-only
    user_routes.ts                  # POST /users
    connection_routes.ts             # POST /connections, GET /connections/:id (client-facing half only)
    action_routes.ts                  # POST /actions/:app/:action
    trigger_routes.ts                  # POST /triggers/:app/:trigger/subscribe (subscription mgmt only)
    webhook_routes.ts                   # GET /oauth/callback/:app + (Phase 6) inbound trigger webhooks —
                                          # grouped because both are "external service calls us", see file header
  server.ts                        # Bun.serve — just composes src/api/*_routes.ts, no route bodies here
index.ts                           # entrypoint, starts server.ts
```

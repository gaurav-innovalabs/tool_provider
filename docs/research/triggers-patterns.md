# Trigger patterns synthesis

Synthesizes webhook/polling/event-trigger patterns across the surveyed platforms. Secondary priority to auth per the user's stated focus, but the design fork here is significant enough to resolve deliberately rather than by default.

## The central fork: per-trigger endpoint vs. fan-in endpoint

Two genuinely different architectures, both proven at scale:

**A. Per-trigger-instance public endpoint** (Pipedream, n8n, Activepieces)
- Each deployed trigger gets its own dedicated inbound URL (Pipedream: `$.interface.http` provisions one per component instance; n8n: `webhook.service.ts` registers one per active workflow trigger node).
- Third-party webhook payload is simple to route (URL alone identifies the trigger) and simple to reason about (one trigger's traffic doesn't need a discriminator inside the payload).
- Cost: many endpoints to provision, secure, and clean up on trigger deletion; needs a real router/registry (n8n's `active-workflow-manager.ts` is an in-memory registry re-synced on boot).

**B. Single fan-in endpoint per consumer** (Composio)
- One webhook URL per project/consumer; every trigger instance's events are POSTed to that same URL, signed for authenticity.
- Simpler operationally (one endpoint to provision/secure per tenant, not per trigger); the receiver must be able to tell events apart by payload content (trigger type + instance id in the body), not by URL.
- This is Composio's explicit design choice for the "real" production path, with a WebSocket `subscribe()` (Pusher-backed) offered separately as a prototyping-only shortcut that bypasses the real webhook handler.

**Recommendation**: lean toward B (single signed fan-in endpoint per consumer/tenant) for a from-scratch MCP provider — it avoids building a per-trigger endpoint-lifecycle/router subsystem, and signing + a self-describing payload is simpler to get right than N dynamically-provisioned public URLs. Revisit if there's a concrete reason per-trigger endpoints are needed (e.g. some third-party APIs only support one webhook URL per registration and can't be routed by payload content — check this during Activepieces/Pipedream integration work).

## Webhook registration lifecycle (activate/deactivate)

Pipedream's `hooks.activate()` / `hooks.deactivate()` pattern is the cleanest example: on trigger deploy, call the third-party API to register a webhook pointing at the provisioned endpoint and persist the returned id; on trigger removal, call the API again to deregister using that stored id. This lifecycle is orthogonal to which fork (A or B) is chosen — even a fan-in design still needs to register/deregister with each third-party API individually.

**Design implication**: model trigger instances with an explicit lifecycle state (`activate → active → deactivate → removed`) and store whatever the third-party API returns as a registration handle, regardless of endpoint architecture.

## Don't trust the webhook payload — verify or refetch

Pipedream's Airtable trigger doesn't trust the webhook body at all (Airtable's webhook is just a ping); it fetches actual changes via the API using a stored cursor. This is a useful defensive pattern for third-party APIs with weak/no webhook payload guarantees. Composio and Nango instead sign their *own outbound* webhooks (HMAC) so receivers can verify authenticity — a different but complementary concern (verifying *your* webhook to *your* consumer, vs. trusting a *third party's* webhook to you).

**Design implication**: two independent verification concerns to design for — (1) validating inbound webhooks from third-party APIs (varies per API, sometimes requires refetch-not-trust), and (2) signing your own outbound webhooks to your consumers (HMAC, Nango's `packages/server/lib/webhook/signature.ts` is a concrete reference).

## Dedup and idempotency

- Pipedream: `isDuplicateEvent()` compares `(id, timestamp)` against last-seen values in a per-trigger KV store, guarding a short window (5s).
- n8n: staged-cursor commit pattern for polling — a poll's "last seen" cursor is staged but only committed if the poll succeeds, preventing lost or duplicated events on partial failure.
- Zapier: dedup by `id` is handled by the (closed) hosted infra, not integration author code.

**Design implication**: two mechanisms worth adopting together — a small per-trigger KV/cursor store (for both polling cursors and recent-event dedup keys), and n8n's stage-then-commit discipline so a failed poll doesn't silently lose or double-emit events.

## Polling as a first-class trigger type, not an afterthought

Every platform surveyed except Nango and Klavis (thin/unclear trigger stories) and Airbyte (sync-only, too coarse-grained) treats polling as a peer of webhooks, not a fallback: Pipedream's `$.interface.timer`, n8n's `poll-trigger-executor.ts` + `poll-cursor-hooks.ts`, Zapier's `perform`-on-schedule, Activepieces' polling pieces. Necessary because many third-party APIs simply don't offer webhooks.

**Design implication**: the trigger abstraction needs both a webhook path and a scheduled-poll path from day one, sharing the same downstream event-emission/dedup logic — not bolted on after webhooks ship.

## Outbound webhook delivery hardening (Nango)

Nango's outbound webhook dispatcher (`packages/webhooks/lib/`) includes a `circuitBreaker.ts` — avoiding repeated delivery attempts to a receiver endpoint that's known to be dead/erroring, rather than hammering it on every event. Directly reusable pattern for whichever consumer-facing webhook design (fork A or B above) is chosen.

**Design implication**: outbound delivery needs retry-with-backoff *and* a circuit breaker per consumer endpoint, not unbounded retry.

## Platform-injected capabilities (Pipedream) — a broader architectural idea

Beyond triggers specifically, Pipedream's pattern of injecting typed capabilities into component code (`$.interface.http` for a provisioned endpoint, `$.interface.timer` for scheduling, `$.service.db` for small KV state, `$auth` for the credential) rather than making each integration author reimplement infra is worth adopting structurally: integration/trigger authors write only "what does this specific API's registration/pagination look like," never a webhook server or scheduler themselves.

**Design implication**: define a small set of injected capabilities early (HTTP endpoint provisioning or fan-in signing, a scheduler, a small KV store, a credential accessor) and make every integration's trigger/action code a pure function of those — mirrors the auth-layer recommendation in `auth-patterns.md` #8.

## Trigger setup vs. trigger delivery are TWO SEPARATE concerns — and neither needs new OAuth

Confirmed from Composio's real OpenAPI spec (`https://backend.composio.dev/api/v3/openapi.json`, not docs
prose) and Pipedream's real component source (`other-platforms/pipedream.md`). Directly answers "does a trigger
need its own OAuth / redirect URL setup":

**No — a trigger reuses the exact same connected account/token an Action already has.** There is no
separate OAuth flow, no separate redirect_uri, no separate scope-grant step for enabling a trigger in
either platform. `POST /trigger_instances/{slug}/upsert` (Composio) takes `connected_account_id` (or
`user_id`, auto-resolving the existing connection) — it's just "start listening using the credential that's
already there." The "redirect URL" concept that actually matters for triggers is a **completely different
URL** from the OAuth `redirect_uri` — it's *where trigger events get delivered*, and that's configured
separately from both the connection and the trigger:

- **Composio's real delivery config**: `POST /webhook_subscriptions { webhook_url, enabled_events[] }` —
  one HTTPS URL per subscription, covering many event types across all your trigger instances. This is
  fork **B** (fan-in) from above, now confirmed with the actual field name/shape, not inferred — a single
  `webhook_url`, required to be HTTPS, versioned payload (`V1`/`V2`/`V3`). Nothing per-trigger-instance
  about it.
  - Composio also has a `POST /webhook_endpoints` API that looks superficially similar but is a different
    thing: `{ toolkit_slug, client_id }` — this configures the **third-party app's own** webhook settings
    (e.g. registering *Composio's* receiver URL as a Slack app's Event Subscriptions Request URL). This
    only exists because Composio brokers OAuth (Composio owns the OAuth app registration, so only Composio
    can configure that app's webhook target). **Not applicable to us** — we register our own OAuth apps
    directly (`GMAIL_CLIENT_ID`/`SLACK_CLIENT_ID` in `../../.env.example`), so if a trigger needs a third-party
    push subscription (Slack Events API, Gmail Pub/Sub), *we* configure it directly in that provider's own
    app console/API — no Composio-style intermediary registration step is needed in our architecture at all.
- **Pipedream's real delivery config**: no separate subscription step — fork **A** (per-instance). Each
  trigger's own `hooks.activate()` registers a webhook pointing at that instance's dedicated
  `$.interface.http`-provisioned endpoint, directly with the third-party API, at trigger-deploy time.
  Delivery URL and trigger lifecycle are the same step, not two.

**Design implication for us**: this project already leans fork B (fan-in) per the recommendation above, and
Composio's real schema confirms that's a coherent, provable design — `POST /webhook_subscriptions`'s shape
(`webhook_url` + `enabled_events[]`) is a good concrete model to copy for whatever we eventually add. The
`redirect_uri` machinery already built (`../../src/lib/oauth.ts`, `../../.env.example`'s Gmail/Slack setup) is
untouched by triggers — it's used once at connect-time and never again. What triggers still need, not yet
decided: (1) the scheduler (Phase 3, nothing built), and (2) for Slack specifically, whether `new_message`
polls or uses Slack's own Events API webhook (which — per this section — WE would register directly with
Slack's app config, not through any Composio-style intermediary, since we hold the OAuth app ourselves).

## Slack specifically: webhook, not poll — settled, unanimous across all 3 platforms with real source checked

This was an open TODO in `../../src/components/slack/triggers/newMessage.ts` for a while ("poll for consistency
with Gmail" vs. "webhook since Slack pushes natively"). Resolved by checking actual source/docs, not
guessing:

- **Composio**: `SLACK_CHANNEL_MESSAGE_RECEIVED` / `SLACK_DIRECT_MESSAGE_RECEIVED` are webhook-based —
  confirmed directly from their docs ("The Slack triggers are webhook-based rather than polling-based, so
  the interval configuration may not apply to them").
- **Pipedream**: their Slack "New Message In Channels" trigger is labeled "(Instant)" — Pipedream's own
  term for webhook-based (vs. their polling triggers, which carry no such label). Matches the
  Instant/Polling split already documented in `other-platforms/pipedream.md`.
- **n8n**: read `SlackTrigger.node.ts` directly (not docs) — `description: 'Handle Slack events via
  webhooks'`, with real code for `verifySignature()` and Slack's `url_verification` challenge-response
  handshake (`if (req.body.type === 'url_verification') { res.status(200).json({ challenge:
  req.body.challenge }) }`).

Nobody polls Slack for new-message detection. Makes sense given *why* — Slack's Events API is a
first-class, well-supported real-time push mechanism (unlike Gmail's Pub/Sub, which needs its own GCP
topic + IAM + renewal scheduler just to set up); there's no engineering reason to poll when the provider
pushes cleanly. This settles our own fork **A vs. B** question specifically for Slack: it needs a real
inbound-webhook path (fork A shape — a dedicated receiving endpoint) regardless of which fan-in/per-trigger
model gets chosen for delivery *to our consumers* — those are two different "webhook" concerns (inbound
from Slack to us, outbound from us to whoever subscribed), not to be conflated.

**Also worth noting for Gmail's polling interval**: Composio's 2026-03-11 changelog introduces a **15-minute
minimum** for polling triggers (below that, requests get silently clamped now, will hard-error from
2026-04-15). Our own `TRIGGER_POLL_INTERVAL_MS` defaults to 60s — reasonable for local dev/testing, but
worth revisiting toward something closer to Composio's real-world-tested minimum before this runs against
actual rate-limited accounts at any scale.

## Open fork not yet resolved

Fork A vs. B (per-trigger endpoint vs. fan-in) — still open for *outbound* delivery to our consumers
(leaning B per the earlier section). Slack's *inbound* webhook-from-Slack path is a separate, now-settled
question (webhook, not poll — see above) — see `open-questions.md` for what's still undecided.

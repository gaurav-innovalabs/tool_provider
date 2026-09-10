# Zapier (Platform CLI)

- **Open-source parts**: [zapier/zapier-platform](https://github.com/zapier/zapier-platform) (monorepo containing `zapier-platform-cli` and `zapier-platform-core`) — MIT license
- **Closed/proprietary**: the actual Zap execution engine, the hosted trigger polling/webhook infra, the Zap editor UI, and all of Zapier's own integrations are NOT open source. Only the **developer SDK for building integrations** is public.
- **Stack**: JavaScript/TypeScript (Node.js)

## Architecture overview
Zapier Platform apps are defined as JS/TS modules with four component types:
- **Authentication** — declares what credentials to collect from the user (shown in the "Connect Accounts" step of the Zap editor)
- **Triggers** — functions that read data from an API (either polling or "hook"/webhook-based)
- **Actions** (Creates/Searches) — functions that write data or look up records
- **Resources** — declare an object type + its CRUD operations, and Zapier auto-derives Triggers/Searches/Creates from a Resource definition (reduces boilerplate)

The CLI (`zapier-platform-cli`) lets you scaffold, run auth/trigger/action functions **locally** for testing, then push/deploy to Zapier's (closed) hosted runtime — so the open-source part is dev tooling + the app definition contract, not the runtime that actually executes it at scale.

## Auth model
`authentication` config in the app definition supports several types (`custom`, `basic`, `digest`, `oauth1`, `oauth2`, `session`). For OAuth2 you declare `authorizeUrl`, `getAccessToken`, `refreshAccessToken`, and Zapier's hosted platform handles the actual token storage/refresh scheduling on their infra — the integration code only defines the request/response shape, not where secrets live.

## Trigger model
Two trigger styles in the SDK:
- **Polling triggers** — a `perform` function Zapier calls on a schedule, returning an array of new items (dedup by `id` handled by Zapier's infra)
- **REST hook (webhook) triggers** — `performSubscribe`/`performUnsubscribe` register/deregister a webhook URL with the third-party API; `perform` parses the incoming webhook payload

Both patterns are declared in code but **executed by Zapier's closed hosted infrastructure** (subscription management, retry, dedup) — not something you can inspect or self-host.

## Tool/schema definition format
Each trigger/action declares `key`, `noun`, `display` (label/description — notably this is very close to an MCP tool's `name`/`description`), an `operation.inputFields` (JSON-Schema-like field list), and a `sample` output object used for the Zap editor's data-mapping UI.

## Notable code pointers
- `packages/cli/docs/cli.md` — CLI reference
- `docs.zapier.com/integrations/quickstart/cli-tutorial` — auth/trigger/deploy walkthrough
- GitHub wiki "Example Apps" — reference implementations of auth + trigger + resource patterns

## Takeaways
- **Worth borrowing**: the `inputFields` + `display` + `sample` shape maps almost directly onto MCP tool JSON schemas (name, description, params, example output) — a good reference for designing a tool-definition DSL.
- **Worth borrowing**: the Resource abstraction (define an object once, auto-derive trigger/search/create) reduces integration author boilerplate — relevant if the eventual provider wants a low-effort way for third parties to add integrations.
- **Limitation**: since the runtime is closed, there's nothing here to learn about actual webhook-subscription infra, retry/dedup mechanics, or token storage internals — only the author-facing contract.

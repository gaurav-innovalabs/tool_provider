# Pipedream

- **Repo**: [PipedreamHQ/pipedream](https://github.com/PipedreamHQ/pipedream) (monorepo; 2,700+ integrated apps as `components/`)
- **License**: custom "Other" (NOASSERTION on GitHub — not a standard OSI license; check `LICENSE` before reusing code verbatim)
- **Stack**: mostly JavaScript/Node for the `components/` integration library (2,700+ apps), Python components also supported, platform runtime itself (`platform/`) is Node/TypeScript; workflow engine is closed-source SaaS — the open part is the **component library + component SDK**, not the orchestration/execution backend
- **Stars**: ~11.7k, very active (pushed same day as this research)

## Architecture overview
Pipedream's open-source surface is a library of **components**: `.app.mjs` files (one per integration, e.g. `airtable_oauth.app.mjs`) that define `propDefinitions` (typed, often dynamically-populated input fields) and `methods` (API client calls), plus `sources/` (triggers) and `actions/` (tool calls) that import and compose the app definition. Each app/source/action is a plain JS object with `type`, `key`, `version`, `props`, `methods`, and lifecycle hooks — this is the same shape used for both "workflow step" and, more recently, MCP tool exposure. The actual step-execution engine, scheduler, and multi-tenant webhook router that run these components are Pipedream's closed-source cloud product.

## Auth model
- Every OAuth-capable integration has two component variants: `<app>_oauth` (uses Pipedream's centrally-registered OAuth client) and often a plain `<app>` variant for key/token auth.
- Components never handle the OAuth dance (authorize redirect, code exchange, refresh) themselves. The platform performs OAuth centrally and injects the live token as `this.$auth.<field>` (e.g. `this.$auth.oauth_access_token`) into every method call — see `_headers()` in [`components/airtable_oauth/airtable_oauth.app.mjs`](https://github.com/PipedreamHQ/pipedream/blob/master/components/airtable_oauth/airtable_oauth.app.mjs):
  ```js
  _headers() {
    return { Authorization: `Bearer ${this.$auth.oauth_access_token}` };
  }
  ```
  Component code is fully decoupled from token storage/refresh — it just reads `$auth` fields declared implicitly by the app's OAuth config (managed outside this repo, in the platform).
- For end-user-facing apps built on top of Pipedream, **Pipedream Connect** is the productized version of this: it lets a third party embed "connect your account" flows for any of Pipedream's integrations, generating a per-end-user "Connect Link"/token. Docs state credentials are transmitted over HTTPS and encrypted at rest, and that Connect explicitly does *not* store request/response payloads (to reduce PII/secret retention risk). Token refresh is handled server-side; exact refresh algorithm isn't published in open docs (backend is closed source).

## Trigger model
Two trigger shapes, both implemented as `sources/`:
1. **Instant (webhook-based)** — e.g. [`airtable_oauth/sources/common/common-webhook.mjs`](https://github.com/PipedreamHQ/pipedream/blob/master/components/airtable_oauth/sources/common/common-webhook.mjs). Pattern:
   - `props.http = { type: "$.interface.http", customResponse: true }` — platform provisions a unique inbound HTTPS endpoint per deployed trigger instance.
   - `props.db = "$.service.db"` — platform provisions a per-trigger-instance key/value store.
   - `hooks.activate()` — runs once on deploy; calls the third-party API to *register* a webhook pointing at `this.http.endpoint`, then persists the returned webhook id via `this.db.set("hookId", id)`.
   - `hooks.deactivate()` — runs on trigger removal; calls the API to delete the registered webhook using the stored id.
   - `run()` — invoked on every inbound HTTP hit; for Airtable specifically it doesn't trust the webhook body (Airtable's webhook is just a ping), so it fetches actual changes via `listWebhookPayloads` with a stored cursor, then emits via `this.$emit(data, meta)`.
   - Dedup: `isDuplicateEvent()` compares `(id, timestamp)` against last-seen values stored in `db`, guarding against duplicate emits within a 5s window.
2. **Polling (timer-based)** — e.g. [`components/mysql/sources/common.mjs`](https://github.com/PipedreamHQ/pipedream/blob/master/components/mysql/sources/common.mjs). Pattern: `props.timer = { type: "$.interface.timer", default: { intervalSeconds: N } }`; platform invokes `run()` on that interval; component tracks a cursor (`db.get("lastResult")`/`db.set(...)`) and emits only new rows since the cursor.

Both patterns push all "how do I run on a schedule / how do I get a public URL / how do I store small per-trigger state" concerns onto platform-provided prop *interfaces* (`$.interface.http`, `$.interface.timer`, `$.service.db`) rather than the component reimplementing them — the component author only writes the third-party-API-specific glue (register/deregister webhook, fetch-since-cursor, dedupe key choice).

## Tool/schema definition format
Components (`actions/*.mjs`) export `{ key, name, description, version, type: "action", props, async run({ $ }) {...} }`; `props` (typed, some with dynamic `async options()` for autocomplete) double as both a workflow UI form schema and — in Pipedream's newer MCP support — the JSON-schema-like input spec exposed to an LLM tool-caller. Same object shape is reused for triggers (`type: "source"`) with `$emit` instead of a return value.

## Notable code pointers
- OAuth token consumption pattern: `components/airtable_oauth/airtable_oauth.app.mjs` (`_headers()`, `_makeRequest()`)
- Webhook trigger lifecycle (activate/deactivate/dedupe/run): `components/airtable_oauth/sources/common/common-webhook.mjs`
- Instant trigger definition composing the common webhook lifecycle: `components/airtable_oauth/sources/new-modified-or-deleted-records-instant/new-modified-or-deleted-records-instant.mjs`
- Polling/timer trigger pattern with cursor-based dedupe: `components/mysql/sources/common.mjs`
- 2,700+ more `<app>.app.mjs` + `sources/` + `actions/` triples under `components/` — a huge reference set of real-world per-API auth quirks and pagination/cursor patterns

## Takeaways
- **Borrow**: the "platform injects capability via typed props" pattern (`$.interface.http`, `$.interface.timer`, `$.service.db`, `$auth`) is a clean separation — component/integration authors write zero infra code (no webhook server, no scheduler, no token refresh), only "what does this specific API's webhook registration/pagination look like." This directly informs an auth-first TS design: define a small set of injected capabilities (HTTP endpoint provisioning, KV store, credential accessor) and make every integration a pure function of those.
- **Borrow**: explicit `activate`/`deactivate` lifecycle hooks for trigger (de)registration, decoupled from the event-handling `run()`.
- **Avoid / note**: the actual OAuth token acquisition/refresh implementation and the multi-tenant webhook router are *not* in this repo (proprietary SaaS backend) — Pipedream's open-source component library assumes that infrastructure exists elsewhere. We cannot copy their refresh logic; we have to design it ourselves (see `../auth-patterns.md`).
- License is non-standard ("Other"/NOASSERTION) — do not copy code verbatim into a project with a different license without checking `LICENSE` terms first; treat this as pattern/architecture reference only.

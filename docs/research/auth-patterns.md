# Auth patterns synthesis

Top-priority doc per the stated build priority ("OAuth/Auth flow first"). Synthesizes concrete, reusable patterns across all 9 surveyed platforms — not a per-platform summary (see `platforms/*.md` for that), but the distilled set of decisions worth carrying into the actual TS design.

## 1. Separate "how does this integration authenticate" from "whose credential is this"

The single strongest pattern in the survey, clearest in **Composio**:
- **Auth Config** (static, admin-configured): which scheme (OAuth2 / API key / basic / custom), OAuth client id/secret, required scopes, token URLs. One per integration (or per integration + custom-app-override).
- **Connected Account / Connection** (dynamic, per-call): the actual stored credential instance for one specific end user against one Auth Config. A user can hold multiple (e.g. two Gmail accounts).

Nango's "Connection" entity and n8n's `CredentialsEntity` + `SharedCredentials` (project/role-scoped) are variations on the same split. **Design implication**: two tables from day one — `auth_configs` (integration, scheme, scopes, client credentials ref, managed-vs-custom flag) and `connected_accounts` (user_id, auth_config_id, encrypted credential blob, expiry, refresh state, status).

## 2. Don't assume OAuth2 is the only scheme

Nango's `connection.service.ts` imports separate clients per scheme: OAuth2, JWT, AWS SigV4, GitHub App installation tokens, HMAC/signature, SAML/JWT assertion. Composio's `AuthScheme.ts` models the same idea as a typed union. Real third-party APIs frequently use API keys, JWT, or custom signing — a design that hardcodes OAuth2 as *the* auth flow will hit a wall on the first non-OAuth integration.

**Design implication**: define an `AuthScheme` union type early (`oauth2 | api_key | basic | jwt | hmac_signature | custom`) with a pluggable client interface per scheme, not a single OAuth-shaped credential table.

## 3. Managed vs. bring-your-own OAuth app, at multiple levels

Consistent across Composio, Pipedream, Airbyte, Klavis: the platform ships a default, centrally-registered OAuth app per integration ("managed"), but lets an org/workspace override with their own client id/secret ("custom"/"override"). Airbyte's reasoning is concrete and important: **refresh tokens are tied to the OAuth app that issued them** — so overriding is not just cosmetic, it changes what refresh tokens are valid.

**Design implication**: `auth_configs` needs an `is_managed: boolean` + optional `custom_client_id/secret` from the start, even if only the managed path ships first — retrofitting this later means a painful token-migration story.

## 4. Proactive refresh + explicit failure state machine (Nango)

The most concrete, directly-portable pattern found:
- Compute `credentials_expires_at` from the token response.
- Refresh **ahead of expiry** using a margin constant (e.g. refresh 5 minutes before actual expiry), not reactively on a 401.
- Track `last_refresh_success`, `last_refresh_failure`, `refresh_attempts` on the connection row.
- After a `MAX_CONSECUTIVE_DAYS_FAILED_REFRESH`-style cutoff, mark the connection `refresh_exhausted` — a terminal state that stops retrying and instead surfaces "reconnect needed" to the user/caller.

**Design implication**: this is close to a ready-made spec — implement it near-verbatim rather than inventing a refresh strategy from scratch. Avoid the naive "retry forever on 401" trap.

## 5. Encrypt at rest, decrypt only transiently in memory

n8n's `Credentials` class (encrypt on `setData()`, decrypt on `getData()`, via a single `Cipher` service) and Nango's `encryptConnection()`-before-every-write pattern agree: credentials are stored encrypted, decrypted only for the duration of an actual outbound call, never held decrypted longer than necessary, and never logged/persisted in decrypted form. Pipedream's Connect docs additionally call out **not storing request/response payloads** at all, to reduce secret/PII retention surface.

**Design implication**: one central `Cipher`/`EncryptionManager` service, credential fields typed so they can't accidentally be serialized decrypted (e.g. a wrapper type, not a bare string) in logs or API responses.

## 6. Auth-on-demand via a meta-tool, not just pre-flight setup (Composio)

Composio's `COMPOSIO_MANAGE_CONNECTIONS` meta-tool lets an agent generate a "Connect Link" mid-conversation when a tool call needs auth the user hasn't granted yet, and hand that link directly to the user in chat — credentials never pass through the agent's own server, only a link does.

**Design implication**: worth planning for from the start if the eventual MCP provider is meant to be used conversationally by an LLM agent — auth shouldn't require a separate out-of-band setup step before any tool can be used.

## 7. Centralized declarative config vs. per-integration code — a real tradeoff

Two competing models, both viable:
- **Declarative/centralized** (Nango's provider registry, Windmill's typed Resources, n8n's `ICredentialType` schema-as-data): integration authors describe auth in data, a shared engine handles the mechanics. Less boilerplate per integration, less flexibility for oddball APIs.
- **Per-integration code** (Activepieces' pieces-framework, Pipedream's `.app.mjs`): each integration implements its own auth logic in TypeScript. More flexible, more boilerplate, easier to onboard community-contributed integrations without touching core engine code.

**Design implication**: not resolved by this research — genuinely depends on how much third-party/community integration authorship is expected. Tracked as an open question (`open-questions.md`).

## 8. What's NOT visible anywhere in these OSS repos

Every hosted platform (Pipedream, Composio, Nango, Zapier, Klavis's managed side) keeps the actual multi-tenant token storage schema, encryption-key management, and refresh scheduler *infrastructure* (queues, cron, secret storage) in a closed backend. The patterns above are the *shape* of a solution, not a copy-pasteable implementation. n8n, Airbyte, Activepieces, and Windmill are the only fully self-hostable references — worth a closer code-level read of n8n's `packages/core/src/credentials.ts` and Windmill's Resources backend before finalizing the storage layer design.

## Recommended starting point

Combine: Composio's Auth Config / Connected Account split (schema) + Nango's pluggable-per-scheme client + proactive-refresh/failure-state-machine (refresh logic) + n8n's single-Cipher-service encryption pattern (storage) + Airbyte's managed-vs-override OAuth app model (multi-tenancy). This combination draws only from MIT-licensed (Composio, Activepieces) or self-hostable reference implementations (n8n, Airbyte) for anything that might be code-adjacent, and treats Nango/Pipedream as pattern-only references given their non-standard licenses.

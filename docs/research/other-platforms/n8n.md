# n8n

- **Repo**: [n8n-io/n8n](https://github.com/n8n-io/n8n) — 203.8k+ stars, actively developed (commits same-day as of research).
- **License**: "Fair-code" (Sustainable Use License / n8n Enterprise License, not OSI-approved open source — source-available with restrictions on offering it as a competing hosted service). Note this if licensing purity matters for the eventual build.
- **Stack**: TypeScript monorepo (pnpm workspaces): `packages/core` (execution engine), `packages/cli` (server/API), `packages/workflow` (shared types/interfaces), `packages/nodes-base` (400+ built-in integration nodes), `packages/@n8n/db` (TypeORM entities).

## Architecture overview
n8n is a visual workflow engine, not a pure tool-calling MCP-style provider — but its **node** abstraction (an integration = a `.node.ts` file declaring inputs/outputs/actions + an optional paired `.credentials.ts` file declaring its auth) is directly analogous to an MCP tool + its auth requirement. Nodes are loaded at boot (`packages/cli/src/load-nodes-and-credentials.ts`), credentials are stored separately from nodes and referenced by ID, and workflows wire nodes together. Triggers are just a category of node (`*Trigger.node.ts`) that either register a webhook or run on a poll/schedule.

## Auth model
- **Credential schema is declarative**: each `*.credentials.ts` file implements `ICredentialType` with a `properties: INodeProperties[]` array — e.g. [`OAuth2Api.credentials.ts`](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/credentials/OAuth2Api.credentials.ts) declares `grantType` (Authorization Code / Client Credentials / PKCE), `authUrl`, `accessTokenUrl`, `scope`, etc., with `displayOptions.show` conditionals so the UI only shows fields relevant to the selected grant type. Per-service credentials (e.g. `SlackOAuth2Api.credentials.ts`) subclass/extend the generic OAuth2 type with fixed URLs/scopes.
- **Storage/encryption**: `packages/core/src/credentials.ts` — the `Credentials` class encrypts on `setData()` and decrypts on `getData()` via a `Cipher` service (`@/encryption/cipher`, `encryptV2`/`decryptV2`), and only ever holds decrypted data in memory transiently. Encrypted blob + metadata (`id`, `name`, `type`) is what's persisted.
- **Sharing/ownership**: credentials are entities (`CredentialsEntity`) that can be shared to **projects** via a join entity `SharedCredentials` (`packages/@n8n/db/src/entities/shared-credentials.ts`) with a `role` (owner/editor/user) — i.e. credentials are project-scoped with RBAC, not just per-user.
- **OAuth2 flow implementation**: `packages/@n8n/client-oauth2/` is n8n's own small OAuth2 client library (`code-flow.ts`, `credentials-flow.ts`, `client-oauth2-token.ts`) supporting auth-code, client-credentials, and PKCE grants. `packages/cli/src/services/oauth2-flow-proxy.service.ts` proxies the authorize/callback exchange server-side so client secrets never reach the browser.
- **Newer: n8n-as-OAuth-provider**: `packages/workflow/src/n8n-oauth2-auth.ts` shows n8n now also acts as an OAuth2 **resource server** itself (validating bearer tokens presented *to* a Webhook/MCP-trigger node, advertising `.well-known/oauth-protected-resource` per RFC 9728) — relevant if the eventual build needs to expose its own MCP endpoints behind OAuth, not just consume third-party OAuth.

## Trigger model
- Trigger nodes are either **webhook-based** or **poll-based**; a third category is schedule/cron nodes.
- Webhook path: `packages/cli/src/webhooks/webhook.service.ts`, `live-webhooks.ts`, `webhooks.controller.ts` register/dispatch inbound HTTP calls to the right workflow; `waiting-webhooks.ts` handles "wait for webhook" mid-workflow resumption; `test-webhooks.ts` is a separate ephemeral path used while designing a workflow (temporary registration, not persisted).
- Activation/registration: `packages/cli/src/active-workflow-manager.ts` and `packages/core/src/execution-engine/active-workflow-triggers.ts` manage which workflows currently have live triggers registered (in-memory registry, re-synced on boot/deploy).
- Poll path: `packages/core/src/execution-engine/poll-trigger-executor.ts` runs a poll trigger's `poll()` on a schedule; `poll-cursor-hooks.ts` manages a **staged cursor** commit pattern — a poll can update its "last seen" cursor, but the commit is staged and only persisted if the poll succeeds, preventing lost/duplicated events on failure. `packages/cli/src/scheduling/poll-trigger-node/poll-trigger-task-handler.ts` is the scheduler-side task handler.
- MCP-specific: n8n has already grown an MCP trigger surface (`workflow-mcp-trigger-resource.resolver.ts`, `chat-trigger-resource.resolver.ts`) reusing the same OAuth2-resource-server identity code as the Webhook node — worth reading directly if the eventual build wants to expose workflows/tools as MCP servers with per-caller identity.

## Tool/schema definition format
Each node exports `description: INodeTypeDescription` with `properties: INodeProperties[]` (same shape used for credentials) describing typed, conditionally-visible parameters — effectively a hand-rolled JSON-schema-like DSL predating widespread JSON Schema adoption in this space. Not directly MCP tool-schema compatible, but the conditional-visibility (`displayOptions`) idea is a useful UX pattern for tool parameter forms.

## Notable code pointers
| Purpose | Path |
|---|---|
| Credential encryption | `packages/core/src/credentials.ts` |
| Credential entity + sharing | `packages/@n8n/db/src/entities/shared-credentials.ts` |
| OAuth2 credential schema example | `packages/nodes-base/credentials/OAuth2Api.credentials.ts` |
| n8n's own OAuth2 client lib | `packages/@n8n/client-oauth2/src/*.ts` |
| Server-side OAuth proxy | `packages/cli/src/services/oauth2-flow-proxy.service.ts` |
| n8n-as-resource-server (bearer validation) | `packages/workflow/src/n8n-oauth2-auth.ts` |
| Webhook registration/dispatch | `packages/cli/src/webhooks/webhook.service.ts`, `live-webhooks.ts` |
| Active trigger registry | `packages/core/src/execution-engine/active-workflow-triggers.ts` |
| Poll trigger executor + cursor staging | `packages/core/src/execution-engine/poll-trigger-executor.ts`, `poll-cursor-hooks.ts` |
| MCP trigger resource resolvers | `packages/cli/src/modules/oauth-server/protected-resource-resolvers/workflow-mcp-trigger-resource.resolver.ts` |

## Takeaways
- **Borrow**: declarative credential-schema-as-data (not code) for building per-provider auth forms generically; encrypt-at-rest with a single cipher service and never persist decrypted data; project/role-scoped credential sharing instead of pure per-user; staged-cursor commit pattern for exactly-once-ish polling; separating a lightweight "test" webhook registration from the persisted one.
- **Avoid/watch**: n8n's OAuth2 client lib and node property DSL are deeply coupled to its own workflow engine — not something to adopt wholesale, just the patterns. License is not permissive OSS, so don't vendor code from it if the eventual project needs a permissive license — treat it as a reference, not a dependency.

# Composio

- **Repo**: [ComposioHQ/composio](https://github.com/ComposioHQ/composio)
- **License**: MIT
- **Stack**: TypeScript SDK (`ts/packages/core`, `ts/packages/vendor`) + Python SDK (`python/composio`) as the primary open-source deliverables; per repo topics also ships `mcp`/`remote-mcp-server`/`sse` support. Backend (toolkit execution infra, connected-account/token storage, trigger delivery service) is a hosted SaaS, not in this repo — the repo is the **client SDK** for that service, similar in spirit to Stripe's SDKs.
- **Stars**: ~30.1k, very active (pushed within the last day)

## Architecture overview
Composio's core abstraction is **Toolkits** (1000+ integrations) exposed as callable **Tools**, scoped per end-`userID`. Key SDK modules under `ts/packages/core/src/models/`: `AuthConfigs.ts`, `ConnectedAccounts.ts`, `ConnectionRequest.ts`, `Toolkits.ts`, `Tools.ts`, `Triggers.ts`, `MCP.ts`, `Sessions.ts`, `SessionContext.ts`, `ToolRouter.ts`. The SDK is explicitly agent-framework-agnostic: a `provider/` layer adapts Composio's tool format to OpenAI/Anthropic/LangChain/etc. tool-calling formats. Execution itself (actually calling the third-party API) happens server-side in Composio's cloud — the SDK's job is to fetch tool schemas, manage the auth handshake, and relay trigger events; it is not a self-hostable full backend from this repo alone.

## Auth model
This is Composio's most distinctive design choice and the most relevant to the planned build:
- **Auth is always per-`userID`**, not per-workspace-only. Quote from docs: *"your agent runs the same tools for many people, and every tool call runs as a specific user against that user's connected accounts."* This bakes multi-tenant credential isolation into the core model rather than bolting it on later.
- Two distinct entities, kept separate in the SDK (`AuthConfigs.ts` vs `ConnectedAccounts.ts`):
  - **Auth Config** — describes *how* a toolkit authenticates: OAuth vs API key vs other scheme, required scopes, credential template. Composio ships managed auth configs (their own OAuth app registrations) by default per toolkit; you can instead supply a **custom auth config** (bring-your-own OAuth client ID/secret, custom scopes) via `ConnectionRequest.ts`.
  - **Connected Account** — the actual per-user stored credential instance after authorization. A single user can hold multiple connected accounts for the same toolkit (e.g. work vs personal Gmail).
- **Connect Link flow**: generated on demand for a given `userID`; credentials "never pass through your app or the model," so the link is safe to hand directly to an LLM/agent to relay to the end user in chat — the actual OAuth code exchange happens between the user's browser and Composio's backend, not through your server.
- **Managed vs custom auth**: a built-in `COMPOSIO_MANAGE_CONNECTIONS` meta-tool can generate Connect Links automatically mid-agent-session when a tool call needs auth the user hasn't granted yet — i.e. auth-on-demand rather than pre-flight.
- Token refresh is fully automatic and invisible to the SDK caller: once a `Session` is created with a `userID`, subsequent tool calls transparently use the current (refreshed if needed) stored credential; no refresh API is exposed to the caller because the backend owns it.
- `AuthScheme.ts` in the core package models the differing shapes (OAuth2, API key, basic auth, etc.) as a typed union, which is the concrete artifact worth mirroring in a from-scratch design.

## Trigger model
Modeled in `Triggers.ts`. A **trigger type** is a template ("new email in Gmail"); a **trigger instance** (`ti_*` id) is that type activated for one specific user's connected account — independently enable/disable/delete-able. Delivery has two modes:
- **Webhook (production path)**: you register one webhook URL per project; Composio POSTs every event from every trigger instance to that single URL, signed so you can verify authenticity server-side. This is the "real" integration path — one ingress endpoint per consumer, not per trigger.
- **`subscribe()` (prototyping path)**: opens a WebSocket (backed by Pusher under the hood) and streams events directly to your process with zero webhook/tunnel/signature setup — explicitly documented as a shortcut for local dev/prototyping, not meant for production since it bypasses your real webhook handler.

Notably the trigger *registration* (which third-party webhook/poll to set up) is entirely server-side/hosted — the OSS SDK only creates/lists/deletes trigger instances via API calls (`Triggers.ts`), it does not itself run pollers or hold webhook state; that responsibility lives in Composio's backend, same limitation as Pipedream's OSS component library.

## Tool/schema definition format
Tools are fetched dynamically from the backend as JSON-schema-shaped definitions (`Tools.ts`) and adapted per target framework by `provider/` adapters — i.e. one canonical tool schema, many output shapes (OpenAI functions, Anthropic tools, MCP tool defs, etc.). `CustomTool.ts` + `customToolExecution.ts` allow defining your own local tools that get merged into the same interface Composio's built-in toolkits use, so custom and Composio-hosted tools are interchangeable to the calling agent.

## Notable code pointers
- Auth type separation: `ts/packages/core/src/models/AuthConfigs.ts`, `ConnectedAccounts.ts`, `ConnectionRequest.ts`, `AuthScheme.ts`
- Trigger instance lifecycle: `ts/packages/core/src/models/Triggers.ts`
- Per-user session/token context: `ts/packages/core/src/models/SessionContext.ts`, `Sessions.ts`
- Framework-agnostic tool adaptation: `ts/packages/core/src/provider/`
- Custom/local tool merge path: `ts/packages/core/src/models/CustomTool.ts`, `customToolExecution.ts`
- MCP-specific surface: `ts/packages/core/src/models/MCP.ts`, `ToolRouter.ts`, `ToolRouterSession.ts` (directly relevant since the end goal is an MCP tool provider)

## Takeaways
- **Borrow**: the Auth Config / Connected Account split is the cleanest multi-tenant auth model seen in this survey — it cleanly separates "how does toolkit X authenticate" (a static, admin-configured thing) from "which specific user's credential am I using right now" (a dynamic, per-call thing). This maps directly onto a future TS schema: `auth_configs` table (toolkit, scheme, scopes, client id/secret ref) + `connected_accounts` table (user_id, auth_config_id, encrypted credential, refresh state).
- **Borrow**: auth-on-demand via a meta-tool (`COMPOSIO_MANAGE_CONNECTIONS`) rather than requiring pre-flight connection setup — lets an agent request access mid-conversation.
- **Borrow**: one webhook URL per consumer/project, signed, fanning in all trigger instances — simpler operationally than per-trigger public endpoints (contrast with Pipedream's per-trigger `$.interface.http`); worth deciding deliberately which model to copy since they're a real tradeoff (single endpoint = simpler routing/signing but every trigger type's payload shape must be self-describing; per-trigger endpoint = simpler payload handling but many endpoints to manage/secure).
- **Note**: like Pipedream, the actual credential storage/encryption/refresh implementation is not visible in the OSS repo (SaaS backend) — the SDK only exposes the *shape* of the auth model, not its storage implementation. MIT license does make the SDK code itself freely reusable, unlike Pipedream's non-standard license.

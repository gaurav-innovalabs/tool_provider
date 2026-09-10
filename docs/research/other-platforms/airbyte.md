# Airbyte

- **Repo**: [airbytehq/airbyte](https://github.com/airbytehq/airbyte) — MIT (core) + ELv2 (some connectors)
- **Stack**: Java/Kotlin (platform), Python (CDK for connectors), Docker-based connector execution
- **Docs**: [OAuth flow](https://docs.airbyte.com/platform/using-airbyte/oauth), [Connectors & credentials (AI Agents)](https://docs.airbyte.com/ai-agents/concepts/architecture/connectors-and-credentials)

## Architecture overview
Airbyte is fundamentally an **ELT (data movement) platform**, not a tool-calling/action platform. A "connector" is a Dockerized process implementing a `source`/`destination` spec (declared via a JSON Schema `spec.json`) that reads/writes data in batches via the Airbyte Protocol (`spec` → `check` → `discover` → `read`/`write`). It has recently added an "Agent Connectors" layer that repackages sources as read/search/write actions for AI agents, but the primitive is still data sync, not arbitrary API tool calls.

## Auth model
- Two tiers: **Airbyte Cloud managed connectors** (Airbyte holds its own registered OAuth client_id/secret for popular services — user just clicks "authorize") vs **self-managed/marketplace connectors** (org registers its own OAuth app with the third party, enters client_id/secret into Airbyte).
- Credential shape depends on the service: API key, PAT, or OAuth (client_id + client_secret + refresh_token).
- Airbyte **auto-rotates access tokens at execution time** using the stored refresh token — the platform, not the connector, owns refresh scheduling.
- OAuth "override" credentials can be set at workspace or organization level when an org wants its own OAuth app instead of Airbyte's shared one — necessary because the authorization server ties refresh tokens to the specific app that issued them.

## Trigger model
Not event/webhook-driven in the tool-provider sense — Airbyte connectors run on **scheduled syncs** (cron-like) or manual/API-triggered runs. There is no polling/webhook trigger abstraction comparable to Pipedream/n8n/Composio; "triggers" here mean "when does the next data sync happen," not "when does an external event fire an action."

## Tool/schema definition format
Each connector exposes a `spec.json` (connection config schema) and per-stream JSON Schemas for records — this is a data schema, not an MCP-style callable-tool schema. Not directly reusable for an MCP tool provider without significant adaptation.

## Notable code pointers
- `docs/platform/using-airbyte/oauth.md` — OAuth flow docs
- `docs/ai-agents/concepts/architecture/connectors-and-credentials.md` — newer agent-facing credential model
- Airbyte CDK (Python) — connector scaffolding, not reviewed in depth here

## Takeaways
- **Relevance is limited.** Airbyte's core abstractions (batch data sync, Docker-per-connector, JSON Schema record streams) don't map well onto an MCP/tool-calling provider where the unit of work is a single parameterized action call, not a data pipeline.
- **What's worth borrowing**: the two-tier OAuth model (platform-managed shared OAuth app vs. bring-your-own-app override at workspace level) is a clean pattern worth adopting regardless of domain — it's the same trade-off Composio/Pipedream/Nango make.
- **What to avoid**: don't model triggers as "sync schedules" — that's too coarse for an agent tool-calling context that needs per-event webhooks.

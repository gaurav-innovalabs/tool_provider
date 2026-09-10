# Klavis AI

- **Repo**: [Klavis-AI/klavis](https://github.com/Klavis-AI/klavis) — MIT license
- **Backing**: Y Combinator (X25), founded by ex-Google DeepMind / ex-Lyft engineers
- **Discovered during**: broad open-source search for MCP-ecosystem projects — high relevance since it's an **MCP-first** tool/auth provider, closest in stated purpose to this project's own goal

## Architecture overview
Klavis is explicitly positioned as infrastructure for AI agents to "reliably connect with external tools and services at scale" via MCP. It ships 50+ production-ready MCP servers (GitHub, Slack, Gmail, Salesforce, Linear, Notion, Discord, YouTube, Jira, Postgres, Supabase, and more) with built-in enterprise OAuth support. Offers both a **self-hosted (open-source components)** path and a fully-managed hosted option — same dual-mode strategy as Composio/Pipedream.

## Auth model
Built-in authentication layer handling OAuth flows and secrets management "for both developers and end-users" — i.e. it distinguishes platform-developer credentials (the app registered with the third party) from end-user credentials (the individual whose account is being connected), which is the same two-party OAuth split seen in Airbyte's managed-vs-override model and Nango's core design. Provides OAuth authorization URLs directly for flows like GitHub.

## Trigger model
Not clearly documented in the sources reviewed this pass — Klavis's public materials emphasize the MCP tool-calling side (agents invoking tools) more than an event/webhook trigger system. Flag as an open question for a follow-up deeper read of the repo (check for webhook/trigger primitives vs. it being purely request/response tool-calling).

## Tool/schema definition format
Each integration is exposed as a standard **MCP server** (i.e. native MCP tool schema — JSON Schema per tool, following the MCP spec directly) rather than a proprietary format that needs translation. This is the most directly reusable format of anything surveyed, since the eventual project's target output format is MCP itself.

## Notable code pointers
- `LLM.md` in the repo — appears to be an AI-agent-oriented onboarding doc, worth reading directly for architecture details
- Per-server docs at klavis.ai/docs/mcp-server/<service> (e.g. GitHub) — describe OAuth URL issuance per integration

## Takeaways
- **Most directly comparable project found.** Same target protocol (MCP), same dual self-host/managed model, open-source (MIT) core — this is likely the single best "read the actual source" candidate for a deeper follow-up pass, specifically the OAuth/secrets module and however many "trigger" primitives (if any) it has.
- **Open question to resolve in a follow-up**: does Klavis support event-driven triggers at all, or is it purely synchronous tool-calling? This directly affects whether it's a good architectural reference for the Trigger half of this project's goals, or only for the Auth half.

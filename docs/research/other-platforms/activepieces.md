# Activepieces

- **Repo**: [activepieces/activepieces](https://github.com/activepieces/activepieces) — MIT (Community Edition); enterprise features under a commercial license
- **Stack**: TypeScript throughout, Bun (per `bunfig.toml`), Turbo monorepo, Node.js runtime
- **Discovered during**: broad open-source search (not in original named list) — highly relevant since it's TS-native and explicitly MCP-oriented

## Architecture overview
Integrations are called **"pieces"** — standalone TypeScript **npm packages** with hot-reload support for local development. A piece bundles related **actions** and **triggers**. ~400+ pieces exist, ~60% community-contributed, all published to npmjs.com and open source (this transparency is a notable contrast to Composio/Pipedream where many integrations are closed-source even if the platform core is open).

Key structural packages:
- `packages/pieces-framework/` — the SDK/types for authoring a piece (defines action/trigger/auth interfaces)
- `packages/server/` — backend API, flow execution engine

Activepieces auto-generates an **MCP server** from installed pieces, exposing ~400 MCP servers/tools directly usable by Claude Desktop, Cursor, Windsurf — i.e. it already does roughly what this project wants to build, and is TypeScript-native, making it the single closest reference implementation found.

## Auth model
Each piece defines its own auth requirement via the pieces-framework (OAuth2, API key, or custom/basic auth schemes) using typed auth property builders. Since pieces are just TS code, the auth flow (authorize URL, token exchange, refresh) is implemented per-piece in TypeScript rather than via a platform-wide declarative OAuth config — more flexible per-integration, more boilerplate per-integration (a trade-off vs. Nango's unified-config approach).

## Trigger model
Dual-mode, matching Zapier's split:
- **Webhook-based** triggers — real-time, third party pushes to a Activepieces-hosted endpoint
- **Polling-based** triggers — Activepieces polls on a schedule and diffs for new items

Both are declared as part of a piece's trigger definition in the same TS package as its actions.

## Tool/schema definition format
Piece actions/triggers define typed `props` (input schema, similar spirit to Zapier's `inputFields`) plus name/description — this is what gets surfaced as an MCP tool schema when exposed via their MCP server generation. Worth reading `packages/pieces-framework` source directly in a follow-up pass since it's the most directly transferable code to this project's stack (same language, same MCP target).

## Notable code pointers
- `packages/pieces-framework/` — piece/action/trigger/auth type definitions (highest-value read for next pass)
- `packages/server/` — execution engine, would show how triggers get scheduled/dispatched and how the MCP server is generated from pieces

## Takeaways
- **Highest-relevance reference found in the broad search.** Same language (TypeScript), same runtime option (Bun), and it already ships MCP server generation from a piece framework — essentially a working precedent for exactly what this project is aiming to build.
- **Worth borrowing**: per-piece TS auth definitions (flexible, type-safe) and the auto-MCP-generation approach (define actions/triggers once, expose as MCP tools automatically).
- **Open question for later**: how much boilerplate per-integration author is acceptable vs. Nango's more centralized/declarative OAuth config — Activepieces trades centralization for flexibility.

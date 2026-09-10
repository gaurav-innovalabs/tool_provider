# Open questions / follow-ups

Unresolved items surfaced during the survey, to revisit before or during the eventual build. Not blocking — flagged so they aren't silently forgotten.

## Needs a deeper source read

- **Activepieces `packages/pieces-framework/`** — the actual auth/action/trigger type definitions. Highest-value follow-up read: same language (TypeScript), same runtime option (Bun) as the planned build, and it already does "define once → auto-expose as MCP tool," which is close to this project's end goal.
- **Windmill's Resources + secret manager backend** (likely in the Rust `backend/` service) — flagged as one of the more centralized, battle-tested auth implementations found, but not deep-dived at the file level yet. Relevant given auth is the stated top priority.
- **Klavis AI trigger story** — unclear from public docs/sources reviewed whether it has any event/webhook trigger system, or is purely synchronous request/response tool-calling. This matters a lot: if Klavis has no trigger system, it's only useful as an Auth+MCP-schema reference, not a Trigger reference, despite being the closest match in stated purpose. Read `LLM.md` in the Klavis repo and search for webhook/trigger primitives directly.
- **n8n `packages/core/src/credentials.ts`** and the `Cipher`/encryption service — worth a closer read since it's one of only two fully self-hostable, permissively-referenceable (pattern-wise) encryption implementations found (the other being Nango, whose license needs verifying first).

## Design decisions not resolved by this research (need a deliberate choice, not a default)

- **Trigger endpoint architecture**: per-trigger-instance public endpoint (Pipedream/n8n/Activepieces) vs. single signed fan-in endpoint per consumer (Composio). See `triggers-patterns.md` — leaning toward fan-in, but not committed.
- **Auth config authorship model**: centralized/declarative (Nango's provider registry, Windmill's Resources, n8n's `ICredentialType`-as-data) vs. per-integration code (Activepieces' pieces, Pipedream's `.app.mjs`). Depends on how much third-party/community integration authorship is expected for this project — unresolved.
- **How much of the closed-backend functionality (multi-tenant token storage infra, webhook fan-out router, refresh scheduler) needs building from scratch vs. can lean on existing infra** (e.g. a queue system, a secrets manager service) — not evaluated in this pass; this research covered *patterns*, not a build-vs-buy analysis of underlying infra (e.g. should credential encryption use a KMS instead of an in-app cipher service like n8n's).

## License verification needed before any code reuse

- **Nango**: shows as "Other" on GitHub; historically Elastic License 2.0 for some components with an OSS core, licensing has changed over time — verify current `LICENSE` terms before referencing or adapting any code (not just patterns).
- **Pipedream**: "Other"/NOASSERTION — treat as pattern/architecture reference only, do not copy code verbatim.
- **n8n**: Sustainable Use License / Fair-code, not OSI-approved (restricts offering it as a competing hosted service) — fine to read for patterns, don't vendor code if a permissive license matters for the eventual project.
- Confirmed safe for direct code reference: **Composio** (MIT), **Activepieces Community Edition** (MIT), **Zapier Platform CLI/Core** (MIT, but only the dev-time SDK contract — no runtime to reuse), **Airbyte core** (MIT; some connectors ELv2), **Klavis** (MIT), **Windmill** (AGPLv3 — fully open but copyleft, factor that in if AGPL is acceptable for this project).

## Not yet covered by this survey

- No MCP-spec-framework-specific research beyond what Activepieces/Composio/Klavis surface incidentally (e.g. reference MCP server SDKs, Smithery, other MCP registries/marketplaces) — the discovery pass in this round focused on integration/auth *platforms*, not the MCP tooling ecosystem itself. Worth a dedicated follow-up pass focused specifically on "MCP server frameworks and registries" if that becomes relevant before the auth/trigger design is finalized.
- No cost/pricing/hosting-model comparison — out of scope for this architecture-focused survey, but relevant later if self-hosting infra choices (queues, KMS, etc.) are being decided.

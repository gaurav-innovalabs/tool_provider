# Research: open-source tool/integration/MCP provider landscape

R&D phase for building a custom TypeScript (Bun/Node) MCP / tool provider with a strong Auth (OAuth/credential management) and Trigger (webhook/polling) flow. This folder documents how existing open-source and open-core platforms solve the same problems, so the eventual build can borrow proven patterns instead of reinventing them from scratch — especially for auth, which is the stated top priority.

## Contents

- `other-platforms/` — one doc per platform surveyed, common template (repo/license/stack, architecture, auth model, trigger model, tool/schema format, notable code pointers, takeaways)
- `comparison.md` — cross-platform matrix for quick scanning
- `auth-patterns.md` — synthesis of auth/credential patterns across all platforms (most detailed doc, per stated priority)
- `triggers-patterns.md` — synthesis of webhook/polling/trigger patterns
- `gmail-deep-dive.md` — Gmail-specific auth+trigger implementation comparison
- `execution-models.md` — direct GitHub links to Gmail action+trigger code (Pipedream/n8n/Activepieces) + each platform's sandboxing/lazy-loading approach, and why we're skipping that complexity for now
- `mcp-connect-flow.md` — how Composio/Pipedream expose dynamic tool-discovery + on-demand-connect over MCP itself (not just their REST API) — R&D that became Phase-MCP-1, now implemented (`../../MCP_GUIDE.md`)
- `mcp-sdk-notes.md` — the real `@modelcontextprotocol/sdk` mechanics (registerTool, stdio vs. HTTP transport) that made `mcp-connect-flow.md`'s design buildable
- `open-questions.md` — unresolved questions to chase before/while building

## Platforms covered

| Platform | Why it's here |
|---|---|
| [Pipedream](other-platforms/pipedream.md) | Named target; component/props injection model, huge integration library |
| [Composio](other-platforms/composio.md) | Named target; cleanest multi-tenant auth model (Auth Config / Connected Account split) |
| [n8n](other-platforms/n8n.md) | Declarative credential schema, encryption service, staged-cursor polling |
| [Nango](other-platforms/nango.md) | Dedicated unified-auth layer — most relevant single reference for auth-first design |
| [Airbyte](other-platforms/airbyte.md) | Two-tier OAuth (managed vs bring-your-own-app); otherwise poor fit (ELT, not tool-calling) |
| [Zapier](other-platforms/zapier.md) | Mostly closed-source; only the platform-CLI dev contract is public |
| [Activepieces](other-platforms/activepieces.md) | Discovered — TS-native, Bun-compatible, MIT, already auto-generates MCP servers from pieces |
| [Windmill](other-platforms/windmill.md) | Discovered — AGPLv3, centralized "Resources" secret/OAuth manager |
| [Klavis AI](other-platforms/klavis.md) | Discovered — MCP-first tool provider, closest in stated purpose to this project |

## Headline findings

1. **Every hosted platform's OSS repo stops at the client/SDK/component layer.** Pipedream, Composio, Nango, Zapier, and (in part) Klavis all keep credential storage/encryption/refresh scheduling and multi-tenant webhook fan-out in a closed-source backend. We can copy the *shape* of their auth/trigger models but must design the storage/refresh implementation ourselves — see `auth-patterns.md`.
2. **Activepieces is the closest working precedent**: TypeScript, Bun-compatible, MIT, and already does "define actions/triggers once → auto-expose as MCP tools" — the exact shape of this project's end goal. Worth a deeper follow-up read of `packages/pieces-framework`.
3. **Composio's Auth Config / Connected Account split** and **Nango's pluggable-per-auth-type client + proactive refresh + failure state machine** are the two strongest concrete patterns for the auth layer.
4. **Trigger design is a real fork in the road**: per-trigger-instance public endpoint (Pipedream, n8n) vs. one signed webhook URL per consumer fanning in all triggers (Composio) vs. centralized outbound-webhook-with-circuit-breaker (Nango). See `triggers-patterns.md` for the tradeoff.
5. Licensing varies a lot: Composio (MIT) and Activepieces (MIT, CE) are safe to draw code from directly; Pipedream ("Other"/NOASSERTION), Nango ("Other", historically Elastic 2.0), and n8n (Sustainable Use / Fair-code) should be treated as pattern references only, not vendored.

## Status

Initial survey complete (9 platforms). Not yet done: deeper source reads of Activepieces' `pieces-framework`, Windmill's Resources/secrets backend, and Klavis's trigger story (or lack thereof) — tracked in `open-questions.md`. No code has been written for the actual TS project yet; this is docs-only per the approved plan.

# Gmail reference code + execution models (Pipedream / n8n / Activepieces)

Only these three platforms have both an Action *and* a Trigger for Gmail with real, browsable open-source
code (Composio's execution backend is closed — docs only; Klavis has no trigger mechanism at all — see
`platforms/*.md` and `gmail-deep-dive.md`). Links below are verified live, not guessed.

## Direct links

| Platform | Action | Trigger | Auth/client |
|---|---|---|---|
| **Pipedream** | [`components/gmail/actions/send-email`](https://github.com/PipedreamHQ/pipedream/tree/master/components/gmail/actions/send-email) | [`components/gmail/sources/new-email-received`](https://github.com/PipedreamHQ/pipedream/tree/master/components/gmail/sources/new-email-received) | [`components/gmail/gmail.app.mjs`](https://github.com/PipedreamHQ/pipedream/blob/master/components/gmail/gmail.app.mjs) |
| **n8n** | [`Gmail.node.ts`](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Google/Gmail/Gmail.node.ts) | [`GmailTrigger.node.ts`](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Google/Gmail/GmailTrigger.node.ts) | [`GoogleOAuth2Api.credentials.ts`](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/credentials/GoogleOAuth2Api.credentials.ts) |
| **Activepieces** | [`send-email-action.ts`](https://github.com/activepieces/activepieces/blob/main/packages/pieces/community/gmail/src/lib/actions/send-email-action.ts) | [`new-email.ts`](https://github.com/activepieces/activepieces/blob/main/packages/pieces/community/gmail/src/lib/triggers/new-email.ts) | [`auth.ts`](https://github.com/activepieces/activepieces/blob/main/packages/pieces/community/gmail/src/lib/auth.ts) |

Note: Activepieces' Gmail piece turned out bigger than the earlier survey suggested — 34 action files total
(drafts, labels, threads, AI-assisted variants), not the lean 2-action set assumed in `gmail-deep-dive.md`.
The two links above are still the right two files to read; ignore the rest of the piece's action files.
Also: `new-email.ts` is confirmed **polling-based** (timestamp cursor, `after:<epoch>` query) — a
`stop-watch-action.ts` exists elsewhere in the piece but the actual trigger doesn't use Gmail's push/watch API.

## Execution model — what each one actually does, and confidence level

**Pipedream** — *not independently confirmed in this pass.* Public docs/blog reachable during this research
didn't state a specific sandboxing technology (no Firecracker/microVM claim verifiable from what was
checked). What is confirmed from source: components are plain JS modules (`props`/`methods`/`run()`)
composed per-workflow-step, not pre-bundled — i.e. some form of per-step dynamic loading is real, but the
"sandboxed" half of the claim is unverified here, not confirmed false. Don't repeat "Pipedream runs
everything in a sandboxed microVM" as a verified fact without a better source (their engineering blog,
specifically, wasn't found via the searches run).

**n8n** — **not sandboxed.** Installed node code runs in the same Node.js process as the server itself —
no VM isolation for the node's own logic. Loading is mixed, not simply "eager" or "lazy": node *metadata*
(for the UI/registry) loads eagerly at boot (`load-nodes-and-credentials.ts`), but a node's *class* isn't
instantiated until a workflow actually executes it.

**Activepieces** — **genuinely sandboxed, confirmed from their own architecture docs**
(`/docs/install/architecture/workers`): Server queues a job (BullMQ/Redis) → a Worker process picks it up →
hands off to a separate **Engine** process → the piece's code runs inside **isolated-vm** (real V8
isolates — separate heap, values cross via serialization, no full Node/npm access from inside the sandbox).
This is a real multi-process, multi-tenant-safe pipeline. Whether piece *code* is lazy-loaded per-flow vs.
bundled at build time wasn't stated in what was checked.

## Why this matters for us — recommendation

Activepieces and n8n sandbox/isolate integration code because **they run code written by third parties**
(community piece/node authors) against **other users'** connected accounts — a real multi-tenant trust
boundary. **We don't have that problem.** Per `../../src/components/TODO.md`, Gmail/Slack integrations in this
project are hand-written by us, not installed from a marketplace — there's no untrusted-author boundary to
sandbox against. Isolated-vm / worker-process architecture (Activepieces) is solving a problem we don't
have yet; skip it for now, revisit only if this ever becomes a "let anyone submit a component" platform.

Same logic for lazy-loading: it matters at Pipedream's 2,700+-component scale so the process doesn't load
everything into memory at boot. At 2 apps (Gmail, Slack), n8n's "load metadata eagerly, instantiate on use"
approach is already more machinery than needed — a plain `import` at the top of `../../src/core/registry.ts`
(what we already do) is fine until the App count is large enough to matter.

**For actually reading/reusing code**: Activepieces (MIT, Community Edition) is the only one of the three
safe to copy code from directly — TypeScript, matches our stack, real license clearance. Pipedream
(non-standard "Other"/NOASSERTION license) and n8n (Sustainable Use License, not OSI-approved) are
pattern-reference only per `open-questions.md` — read them for how they structure the
`historyId`-based Gmail polling (Pipedream) or the OAuth2 credential shape (n8n), but don't paste their code
in.

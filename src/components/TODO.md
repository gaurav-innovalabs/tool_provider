# Component structure — R&D & open decisions

This is where we decide *how a component (App) is declared and organized on disk* before we have 20+ of
them and a rename/refactor gets expensive. Grounded in `docs/research/other-platforms/*.md` — not guessing. Everything
here is a decision to make, not yet decided; mark your call inline or reply and I'll fold it in.

## Naming: "components" not "apps"

Borrowed directly from Pipedream, who call each integration a **component** (`.app.mjs` = the auth/client
definition; `actions/*.mjs` and `sources/*.mjs` = the callable/triggerable pieces layered on top of it).
Composio calls the same idea a **Toolkit**; Activepieces calls it a **Piece**. We're going with Pipedream's
"component" term since it's the most literal fit for "a folder holding one integration's app+actions+triggers".
✅ Already renamed `src/apps/` → `src/components/`.

## How the 3 platforms we can actually read source for structure this

| | Unit of definition | File shape | Shared/common code | Scale (per docs/research/comparison.md) |
|---|---|---|---|---|
| **Pipedream** | one `.app.mjs` (client) + N `sources/*.mjs` (triggers) + N `actions/*.mjs` | plain JS object: `{ key, name, version, props, methods, run() }` — same shape reused for action AND trigger (trigger just uses `$emit` instead of `return`) | `sources/common/*.mjs` per-app (e.g. `common-webhook.mjs` holds the activate/deactivate/dedupe lifecycle, imported by every trigger variant) | 2,700+ components, huge but each one is tiny/independent |
| **Composio** | one Toolkit, described server-side (SDK just fetches its schema) — not really a "file per integration" model in the OSS repo at all | N/A — OSS repo is the client SDK, not the toolkit definitions | N/A (server-side) | 1000+ toolkits, but this is exactly the "too many components, too much SDK surface" pattern you said to avoid |
| **Activepieces** | one `pieces/community/<name>/` npm package | TypeScript: `auth.ts`, `triggers/<trigger>.ts`, `actions/<action>.ts`, `common/*.ts` for shared props/models | `common/props.ts`, `common/models.ts`, `common/data.ts` per piece | ~400 pieces, TS-native — closest to our stack |

**Current skeleton is closest to Activepieces' shape already** (`app.ts` + `actions/*.ts` + `triggers/*.ts`,
TypeScript, one file per action/trigger) — just without a `common/` subfolder yet, since Gmail/Slack don't
need shared helpers between their own action/trigger files *yet*.

## Open decisions

- [ ] **TODO(ask): per-component `common/` folder — add now or when the second trigger/action in the same
      component actually needs to share code?** Pipedream's `sources/common/common-webhook.mjs` pattern
      (shared activate/deactivate/dedupe logic across trigger variants) only pays off once a component has
      multiple triggers of the same *shape* (e.g. Gmail's `new_email` + a future `new_labeled_email` would
      both want the same `historyId` cursor logic). We only have 1 trigger per app right now — premature to
      add `common/` until a second similar trigger exists. Recommend: wait, but flagging so it's a deliberate
      "not yet" and not a forgotten gap.

- [ ] **TODO(ask): should `run()`/`poll()` be a plain object method (Pipedream-style, one big object per
      file) or a factory function that takes injected capabilities (our current `(connection, input) =>`
      shape)?** Pipedream injects capabilities via `this.$auth`, `this.$emit`, `this.db`, `this.http` — i.e.
      the component method reaches *into* a context object the platform hands it. Our current
      `ActionDefinition.run(connection, input)` / `TriggerDefinition.poll(connection, cursor)` signatures are
      a narrower version of the same idea (inject `connection`, return values instead of `$emit`/mutate).
      Worth deciding now whether we'll need more injected capabilities later (a KV store per trigger
      instance, like Pipedream's `$.service.db` — see `docs/research/triggers-patterns.md` "platform-injected
      capabilities") and widen the function signature once, vs. keep it narrow and pass a `ctx` object only
      when Phase 3's scheduler actually needs to hand triggers a KV store.

- [ ] **TODO(ask): one component = one directory always, even for a component with only 1 action and no
      triggers (e.g. a future simple app like "Serper" from `.env.example`)?** Recommend yes, for
      consistency — `registry.ts` shouldn't need to know whether a component is "big" or "small".

- [x] **Input/output schema validation: zod, inline in each `actions/<x>.ts`.** Decided — every action now
      declares `input`/`output` as zod schemas right next to its `run()` (see `gmail/actions/sendEmail.ts`
      for the shape), not split into a separate `.schema.ts` file — at 4 actions total, splitting would be
      premature; revisit if a single action file gets unwieldy. `action_routes.ts` enforces both directions:
      400s on bad caller input, and validates the action's own return value against `output` too (catches
      our own action code lying about its contract). Triggers don't have this yet (`poll()`'s `Cursor`/
      `Event` types are still plain TS interfaces, not zod) — only Actions were in scope for this pass.

- [ ] **TODO(ask): component versioning.** Pipedream versions every single action/source (`version: "0.1.3"`)
      independently, since 2,700+ components change asynchronously and users' existing workflows must keep
      working against an old version. We almost certainly don't need per-action versioning at 2-component
      scale — but if the plan is "grow to many components over time" (per your note), worth deciding now
      whether components get a single `app.ts`-level version or none at all until it's actually needed.

## Explicitly NOT doing (per your steer: "not too many tools/complexity like Composio")

- No dynamic/server-fetched component schemas (Composio's model) — components are defined in this repo's
  source, not fetched from a remote registry. Keeps things inspectable and avoids the "1000+ toolkits" sprawl.
- No auto-derivation of actions from a generic "Resource" (Zapier's Resource → auto Trigger/Search/Create) —
  each action/trigger is hand-written. Revisit only if we end up with many components that are mostly
  boilerplate CRUD (unlikely for Gmail/Slack-shaped integrations).

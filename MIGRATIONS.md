# DB migrations (Bun + Postgres + Drizzle)

**Forward-only, by deliberate choice** — no rollback tooling, no down-migration story. Simplicity over
Rails-style up/down. All three commands below are **verified**, run for real against a local Postgres
(not just written and assumed to work — see "Verified in this pass").

| Command | What it does |
|---|---|
| `bun run db:generate` | Diffs `src/db/schema.ts` against the last snapshot, writes SQL to `src/db/migrations/`. |
| `bun run db:migrate` | Applies every migration in `src/db/migrations/` that hasn't run yet, in order. |
| `bun run db:studio` | Opens Drizzle Studio (a local web UI to browse/edit table data) at `https://local.drizzle.studio`. |

No `db:rollback`, no `db:status` — not because they're hard, but because they were explicitly ruled out.
If a migration is wrong, fix it forward with a new migration (or, only in early local dev before anything's
shipped, hand-edit the bad migration file and re-run `db:generate`/`db:migrate` against a fresh db).

## Why Drizzle (history)

Two earlier passes considered node-pg-migrate specifically because it has a genuine automatic-down-inference
feature (Rails `change`-method style) — verified working against this same local Postgres. Reverted per
explicit steer: forward-only is fine, keep it simple, no `pg` dependency, no rollback script surface at all.
Drizzle's `drizzle-orm/bun-sql` driver wraps `Bun.sql` directly for the *app's own* runtime queries — the
`drizzle-kit` CLI itself (a separate Node process, not the app) needs its own driver to talk to Postgres,
which is why `postgres` (postgres.js, pure JS, no native bindings) is a devDependency — never imported in
`src/`, exactly the same isolation pattern as node-pg-migrate's `pg` peer dependency was.

## Files

- `drizzle.config.ts` — schema path, migrations output dir, reads `DATABASE_URL`.
- `src/db/schema.ts` — table definitions (mirrors `src/types.ts`, see that file's header TODO).
- `src/db/migrations/` — generated SQL + drizzle-kit's snapshot/journal metadata (git-tracked).

## Verified in this pass

Ran against a real local Postgres (throwaway `tool_provider_test` db, dropped after): `db:generate`
produced `0000_fresh_adam_warlock.sql` (4 tables, FKs, correct); `db:migrate` applied it — confirmed all
4 tables exist via `psql \dt`; `db:studio` booted cleanly ("Drizzle Studio is up and running on
https://local.drizzle.studio"). Nothing left behind — test database dropped afterward.

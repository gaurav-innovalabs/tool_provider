// Postgres client. Per CLAUDE.md: use Bun.sql, not `pg`/`postgres.js`.
//
// NOT wired into store.ts yet — src/core/store.ts is still the in-memory Phase 1 implementation. This
// module exists so the Phase 4 migration (see PHASES.md) has a single place to import from, rather than
// every store function reaching for `Bun.sql` directly and scattering connection concerns everywhere.
//
// Bun.sql reads its connection string from `DATABASE_URL` automatically — added to .env.example.

export const db = Bun.sql;

// TODO(ask): schema/migrations approach — Bun has no built-in migration runner. Hand-rolled .sql files run
// on boot (simple, matches "nothing fancy" spirit), or a migration lib? Deciding this now avoids Phase 4
// starting with a half-chosen tool.
// TODO: tables needed, mirroring src/core/types.ts — users, connections, trigger_instances, action_logs
// (+ auth_configs, connected_accounts if Phase 5's bring-your-own-OAuth-app split lands as its own tables
// per research/auth-patterns.md #1, rather than connections just growing more columns).

export async function pingDb(): Promise<boolean> {
  // TODO: `await db`select 1`` (Bun.sql tagged-template syntax), return true/false — used by a future
  // health-check route, not by anything yet.
  throw new Error("not implemented");
}

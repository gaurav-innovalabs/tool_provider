// Postgres client. Per CLAUDE.md: use Bun.sql, not `pg`/`postgres.js`.
//
// Genuinely wired in now — src/core/store.ts (Phase 4) queries through `orm` below, backed by the same
// `db` (Bun.sql) driver already verified working in MIGRATIONS.md. `db` stays exported too for any raw
// SQL that doesn't need Drizzle's query builder.
//
// Bun.sql reads its connection string from `DATABASE_URL` automatically — added to .env.example.

import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "../db/schema";

export const db = Bun.sql;

export const orm = drizzle(db, { schema });

export async function pingDb(): Promise<boolean> {
  try {
    await db`select 1`;
    return true;
  } catch {
    return false;
  }
}

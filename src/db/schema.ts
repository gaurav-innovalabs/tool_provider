// Drizzle schema — source of truth `drizzle-kit generate` diffs against. Mirrors src/types.ts
// (Connection, User, TriggerInstance, ActionLogEntry) exactly — src/core/store.ts is the real backing
// store now (Postgres via drizzle-orm/bun-sql, src/lib/postgres.ts), not in-memory Maps.

import { pgTable, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  user_id: text("user_id").primaryKey(),
  user_metadata: jsonb("user_metadata").notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const connections = pgTable("connections", {
  connection_id: text("connection_id").primaryKey(),
  user_id: text("user_id")
    .notNull()
    .references(() => users.user_id),
  app: text("app").notNull(), // AppId — free text, never a pg enum; restricted by src/types.ts + the registry, not the db schema.
  status: text("status").notNull(), // ConnectionStatus: pending | active | revoked | error | expired
  // Encrypted (AES-256-GCM, src/lib/cipher.ts) opaque base64 blob — NEVER plaintext, NEVER jsonb (a jsonb
  // column would let `SELECT *` or a DB GUI show it decrypted-looking; text keeps it visibly opaque even
  // to someone browsing the table directly). null while status === "pending".
  secrets_encrypted: text("secrets_encrypted"),
  // Opaque, like user_metadata — never encrypted, never secret, see types.ts's Connection.extra_metadata.
  extra_metadata: jsonb("extra_metadata").notNull().default({}),
  // Deadline for finishing the oauth2/api_key connect flow — only set while status === "pending".
  // src/core/connectionExpiry.ts sweeps stale rows past this and flips them to "expired".
  expires_at: timestamp("expires_at", { withTimezone: true, mode: "string" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const triggerInstances = pgTable("trigger_instances", {
  trigger_instance_id: text("trigger_instance_id").primaryKey(),
  connection_id: text("connection_id")
    .notNull()
    .references(() => connections.connection_id),
  user_id: text("user_id").notNull(), // denormalized from connections — avoids a join for /admin/triggers
  app: text("app").notNull(),
  trigger_key: text("trigger_key").notNull(),
  status: text("status").notNull(), // active | paused | error
  webhook_url: text("webhook_url").notNull(),
  // null for webhook-mode triggers (Slack) — only poll-mode triggers (Gmail) use this, see
  // src/core/scheduler.ts's isDue().
  poll_interval_ms: integer("poll_interval_ms"),
  cursor: jsonb("cursor"), // per-app shaped (GmailHistoryCursor vs a Slack shape), jsonb is the only sane column type
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const actionLogs = pgTable("action_logs", {
  log_id: text("log_id").primaryKey(),
  connection_id: text("connection_id")
    .notNull()
    .references(() => connections.connection_id),
  user_id: text("user_id").notNull(), // denormalized, same reasoning as trigger_instances.user_id
  app: text("app").notNull(),
  action_key: text("action_key").notNull(),
  status: text("status").notNull(), // success | error
  called_at: timestamp("called_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  duration_ms: integer("duration_ms"),
  error: text("error"),
});

// One row per trigger RUN (a poll attempt, or one webhook delivery attempt — src/core/scheduler.ts's
// deliverEvent). No retry by design ("no need to retry at all, just failed ok") — this is an audit trail,
// not a queue, so a failed row just sits there as status "error".
export const triggerLogs = pgTable("trigger_logs", {
  log_id: text("log_id").primaryKey(),
  // cascade: DELETE /triggers/:id (unsubscribe) really deletes the trigger_instances row (not a soft
  // delete) — its log history goes with it rather than blocking the unsubscribe with a FK violation.
  trigger_instance_id: text("trigger_instance_id")
    .notNull()
    .references(() => triggerInstances.trigger_instance_id, { onDelete: "cascade" }),
  connection_id: text("connection_id")
    .notNull()
    .references(() => connections.connection_id),
  user_id: text("user_id").notNull(), // denormalized, same reasoning as trigger_instances.user_id
  app: text("app").notNull(),
  trigger_key: text("trigger_key").notNull(),
  status: text("status").notNull(), // success | error
  ran_at: timestamp("ran_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  error: text("error"),
});

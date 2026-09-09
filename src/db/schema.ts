// Drizzle schema — source of truth `drizzle-kit generate` diffs against. Mirrors src/types.ts
// (Connection, User, TriggerInstance, ActionLogEntry). Phase 4 target shape — not wired into
// src/core/store.ts yet, which is still the in-memory Phase 1 implementation.
//
// TODO(ask): duplicates shape already in src/types.ts — once Phase 4 swaps store.ts to Postgres, worth
// deriving types.ts's interfaces FROM this schema (drizzle's `$inferSelect`) to kill the duplication.

import { pgTable, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  user_id: text("user_id").primaryKey(),
  user_metadata: jsonb("user_metadata").notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// TODO: credential should NOT be a plain jsonb column long-term — research/auth-patterns.md #5 says
// encrypt-at-rest via a single Cipher service. jsonb for now, encryption is a Phase 4 follow-up.
export const connections = pgTable("connections", {
  connection_id: text("connection_id").primaryKey(),
  user_id: text("user_id")
    .notNull()
    .references(() => users.user_id),
  app: text("app").notNull(), // AppId — TODO(ask): free-text vs a pg enum once registry is more than gmail/slack?
  status: text("status").notNull(), // ConnectionStatus: pending | active | revoked | error
  credential: jsonb("credential"), // nullable — null while status === "pending"
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
  cursor: jsonb("cursor"), // per-app shaped (GmailHistoryCursor vs SlackPollCursor), jsonb is the only sane column type
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
  called_at: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
  duration_ms: integer("duration_ms"),
  error: text("error"),
});

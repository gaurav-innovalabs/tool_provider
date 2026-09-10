// Phase 4 — real storage. Postgres via Drizzle (src/lib/postgres.ts's `orm`, built on Bun.sql), not
// in-memory Maps — connections/users/triggers/logs now survive a restart and are shared across processes
// (the API server and worker.ts both read/write the same database).
//
// Encryption boundary unchanged from the in-memory version: this file is still the ONLY place that knows
// `secrets` is ever encrypted — every caller elsewhere only ever sees a real Connection with real,
// decrypted `.secrets`. Internally the DB column is `secrets_encrypted` (text, opaque base64), never a
// plaintext/jsonb column — see src/db/schema.ts's comment on why not jsonb specifically.

import { eq, desc, and, or, lt, isNotNull } from "drizzle-orm";
import { orm } from "../lib/postgres";
import { users as usersTable, connections as connectionsTable, triggerInstances as triggerInstancesTable, actionLogs as actionLogsTable, triggerLogs as triggerLogsTable } from "../db/schema";
import { encrypt, decrypt } from "../lib/cipher";
import type { AppId, Connection, Secrets, User, UserId, ConnectionId, TriggerInstance, ActionLogEntry, TriggerLogEntry } from "../types";

function connectionRowToConnection(row: typeof connectionsTable.$inferSelect): Connection {
  return {
    connection_id: row.connection_id,
    user_id: row.user_id,
    app: row.app,
    status: row.status as Connection["status"],
    secrets: row.secrets_encrypted ? (JSON.parse(decrypt(row.secrets_encrypted)) as Secrets) : null,
    extra_metadata: row.extra_metadata as Record<string, unknown>,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function triggerInstanceRowToTriggerInstance(row: typeof triggerInstancesTable.$inferSelect): TriggerInstance {
  return {
    trigger_instance_id: row.trigger_instance_id,
    connection_id: row.connection_id,
    user_id: row.user_id,
    app: row.app,
    trigger_key: row.trigger_key,
    status: row.status as TriggerInstance["status"],
    webhook_url: row.webhook_url,
    poll_interval_ms: row.poll_interval_ms,
    cursor: row.cursor,
    config: row.config,
    extra_metadata: row.extra_metadata as Record<string, unknown>,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const userStore = {
  async create(user: User): Promise<void> {
    await orm.insert(usersTable).values(user);
  },
  async get(userId: UserId): Promise<User | null> {
    const [row] = await orm.select().from(usersTable).where(eq(usersTable.user_id, userId));
    return row ? { user_id: row.user_id, user_metadata: row.user_metadata as Record<string, unknown>, created_at: row.created_at } : null;
  },
  async listAll(): Promise<User[]> {
    const rows = await orm.select().from(usersTable);
    return rows.map((row) => ({ user_id: row.user_id, user_metadata: row.user_metadata as Record<string, unknown>, created_at: row.created_at }));
  },
};

export const connectionStore = {
  async create(connection: Connection): Promise<void> {
    const { secrets, ...rest } = connection;
    await orm.insert(connectionsTable).values({ ...rest, secrets_encrypted: secrets ? encrypt(JSON.stringify(secrets)) : null });
  },
  async get(connectionId: ConnectionId): Promise<Connection | null> {
    const [row] = await orm.select().from(connectionsTable).where(eq(connectionsTable.connection_id, connectionId));
    return row ? connectionRowToConnection(row) : null;
  },
  async update(connectionId: ConnectionId, patch: Partial<Connection>): Promise<void> {
    // `"secrets" in patch` (not `patch.secrets !== undefined`) so patching secrets to `null` on purpose
    // is distinguishable from "this patch doesn't touch secrets at all" — same reasoning the in-memory
    // version had, still applies against a real UPDATE statement.
    const { secrets, ...rest } = patch;
    const dbPatch: Partial<typeof connectionsTable.$inferInsert> = { ...rest };
    if ("secrets" in patch) {
      dbPatch.secrets_encrypted = secrets ? encrypt(JSON.stringify(secrets)) : null;
    }
    const result = await orm.update(connectionsTable).set(dbPatch).where(eq(connectionsTable.connection_id, connectionId)).returning({ id: connectionsTable.connection_id });
    if (result.length === 0) {
      throw new Error(`Cannot update unknown connection: ${connectionId}`);
    }
  },
  async listByUser(userId: UserId, app?: AppId): Promise<Connection[]> {
    const rows = await orm
      .select()
      .from(connectionsTable)
      .where(app ? and(eq(connectionsTable.user_id, userId), eq(connectionsTable.app, app)) : eq(connectionsTable.user_id, userId));
    return rows.map(connectionRowToConnection);
  },
  async listAll(): Promise<Connection[]> {
    const rows = await orm.select().from(connectionsTable);
    return rows.map(connectionRowToConnection);
  },
  // Flips every "pending" connection whose expires_at deadline has passed to "expired" — one SQL
  // statement, no per-row read/decide/write, so it's safe to call from a periodic sweep
  // (src/core/connectionExpiry.ts) without racing a connect flow that finishes right at the deadline.
  async expireStalePending(): Promise<ConnectionId[]> {
    const now = new Date().toISOString();
    const result = await orm
      .update(connectionsTable)
      .set({ status: "expired" satisfies Connection["status"], updated_at: now })
      .where(and(eq(connectionsTable.status, "pending"), lt(connectionsTable.expires_at, now)))
      .returning({ id: connectionsTable.connection_id });
    return result.map((row) => row.id);
  },
};

export const triggerInstanceStore = {
  async create(instance: TriggerInstance): Promise<void> {
    await orm.insert(triggerInstancesTable).values(instance);
  },
  async get(triggerInstanceId: string): Promise<TriggerInstance | null> {
    const [row] = await orm.select().from(triggerInstancesTable).where(eq(triggerInstancesTable.trigger_instance_id, triggerInstanceId));
    return row ? triggerInstanceRowToTriggerInstance(row) : null;
  },
  async update(triggerInstanceId: string, patch: Partial<TriggerInstance>): Promise<void> {
    const result = await orm
      .update(triggerInstancesTable)
      .set(patch)
      .where(eq(triggerInstancesTable.trigger_instance_id, triggerInstanceId))
      .returning({ id: triggerInstancesTable.trigger_instance_id });
    if (result.length === 0) {
      throw new Error(`Cannot update unknown trigger instance: ${triggerInstanceId}`);
    }
  },
  async delete(triggerInstanceId: string): Promise<void> {
    await orm.delete(triggerInstancesTable).where(eq(triggerInstancesTable.trigger_instance_id, triggerInstanceId));
  },
  async listActive(): Promise<TriggerInstance[]> {
    const rows = await orm.select().from(triggerInstancesTable).where(eq(triggerInstancesTable.status, "active"));
    return rows.map(triggerInstanceRowToTriggerInstance);
  },
  async listAll(): Promise<TriggerInstance[]> {
    const rows = await orm.select().from(triggerInstancesTable);
    return rows.map(triggerInstanceRowToTriggerInstance);
  },
  // Client-facing "my subscribed triggers" — distinct from listActive/listAll (admin/scheduler use), and
  // distinct from GET /triggers (trigger_routes.ts), which lists available trigger TYPES, not a user's
  // actual instances. Optional `app` narrows to one app's instances, same filter shape connectionStore's
  // listByUser doesn't have yet (TODO(ask) below).
  async listByUser(userId: UserId, app?: AppId): Promise<TriggerInstance[]> {
    const rows = await orm
      .select()
      .from(triggerInstancesTable)
      .where(app ? and(eq(triggerInstancesTable.user_id, userId), eq(triggerInstancesTable.app, app)) : eq(triggerInstancesTable.user_id, userId));
    return rows.map(triggerInstanceRowToTriggerInstance);
  },
};

export const actionLogStore = {
  async append(entry: ActionLogEntry): Promise<void> {
    await orm.insert(actionLogsTable).values(entry);
  },
  async listRecent(limit: number): Promise<ActionLogEntry[]> {
    const rows = await orm.select().from(actionLogsTable).orderBy(desc(actionLogsTable.called_at)).limit(limit);
    return rows.map((row) => ({
      log_id: row.log_id,
      connection_id: row.connection_id,
      user_id: row.user_id,
      app: row.app,
      action_key: row.action_key,
      status: row.status as ActionLogEntry["status"],
      called_at: row.called_at,
      duration_ms: row.duration_ms ?? undefined,
      error: row.error ?? undefined,
    }));
  },
};

function triggerLogRowToTriggerLogEntry(row: typeof triggerLogsTable.$inferSelect): TriggerLogEntry {
  return {
    log_id: row.log_id,
    trigger_instance_id: row.trigger_instance_id,
    connection_id: row.connection_id,
    user_id: row.user_id,
    app: row.app,
    trigger_key: row.trigger_key,
    status: row.status as TriggerLogEntry["status"],
    ran_at: row.ran_at,
    error: row.error ?? undefined,
    webhook_url: row.webhook_url ?? undefined,
    payload: row.payload ?? undefined,
  };
}

export const triggerLogStore = {
  async append(entry: TriggerLogEntry): Promise<void> {
    await orm.insert(triggerLogsTable).values(entry);
  },
  async get(logId: string): Promise<TriggerLogEntry | null> {
    const [row] = await orm.select().from(triggerLogsTable).where(eq(triggerLogsTable.log_id, logId));
    return row ? triggerLogRowToTriggerLogEntry(row) : null;
  },
  async listRecent(limit: number): Promise<TriggerLogEntry[]> {
    const rows = await orm.select().from(triggerLogsTable).orderBy(desc(triggerLogsTable.ran_at)).limit(limit);
    return rows.map(triggerLogRowToTriggerLogEntry);
  },
  // A "quiet" poll-attempt row — the scheduler checked a poll-mode trigger (Gmail) and genuinely found
  // nothing new: status "success", no error, no payload (poll-attempt rows never carry one — see
  // TriggerLogEntry's own comment). Filtered OUT of the two client-facing list routes below by default
  // (includeEmptyPolls=false) since they're pure "nothing happened" noise, not signal — a caller checking
  // logs almost always wants "what fired" or "what went wrong", not a scroll of quiet checks. Error rows
  // (missing connection, non-pollable trigger, an actual poll failure) are NEVER filtered by this,
  // regardless of includeEmptyPolls — those are always real signal.
  isEmptyPollAttempt(log: TriggerLogEntry): boolean {
    return log.status === "success" && log.payload === undefined;
  },
  // The OTHER half of "consistent, one-unit" log rows: `data_found` (above) says whether this row IS an
  // event (as opposed to a quiet poll-attempt row); `data_sendable` says, for that event, whether it was
  // actually delivered to webhook_url or not — the same signal `status`/`error` already carry, surfaced as
  // one flat boolean so a caller doesn't have to know "status === 'error' means delivery failed" is even a
  // thing. A quiet poll-attempt row (no event, nothing to send) is always false here too — there is nothing
  // for this flag to be true ABOUT.
  isDataSendable(log: TriggerLogEntry): boolean {
    return log.payload !== undefined && log.status === "success";
  },
  // Client-facing "what has this trigger instance actually done" — status/webhook_url/history, the same
  // per-run detail GET /admin/trigger_logs gives an admin, scoped to one instance instead of every user's.
  // Ownership (does this instance belong to the caller's user_id) is checked by the route, not here.
  // `includeEmptyPolls` filters at the SQL level (not after fetching) so `limit` still returns up to N
  // genuinely relevant rows instead of silently returning fewer once quiet polls are dropped client-side.
  async listByInstance(triggerInstanceId: string, limit: number, includeEmptyPolls = false): Promise<TriggerLogEntry[]> {
    const scope = eq(triggerLogsTable.trigger_instance_id, triggerInstanceId);
    const rows = await orm
      .select()
      .from(triggerLogsTable)
      .where(includeEmptyPolls ? scope : and(scope, or(eq(triggerLogsTable.status, "error"), isNotNull(triggerLogsTable.payload))))
      .orderBy(desc(triggerLogsTable.ran_at))
      .limit(limit);
    return rows.map(triggerLogRowToTriggerLogEntry);
  },
  // Client-facing "everything that's fired across EVERY trigger I've subscribed to" — same idea as
  // listByInstance above but not scoped to one trigger_instance_id, for "what happened recently" without
  // already knowing which specific instance to check. `user_id`/`app` are denormalized onto every log row
  // (see triggerLogRowToTriggerLogEntry) specifically so this can filter without a join back to
  // trigger_instances. Optional `app` narrows to one app's triggers, same filter shape connectionStore's
  // listByUser already has. Same `includeEmptyPolls` SQL-level filtering as listByInstance above.
  async listByUser(userId: string, app: string | undefined, limit: number, includeEmptyPolls = false): Promise<TriggerLogEntry[]> {
    const scope = app ? and(eq(triggerLogsTable.user_id, userId), eq(triggerLogsTable.app, app)) : eq(triggerLogsTable.user_id, userId);
    const rows = await orm
      .select()
      .from(triggerLogsTable)
      .where(includeEmptyPolls ? scope : and(scope, or(eq(triggerLogsTable.status, "error"), isNotNull(triggerLogsTable.payload))))
      .orderBy(desc(triggerLogsTable.ran_at))
      .limit(limit);
    return rows.map(triggerLogRowToTriggerLogEntry);
  },
};

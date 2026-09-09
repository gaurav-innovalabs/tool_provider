// Phase 4 — real storage. Postgres via Drizzle (src/lib/postgres.ts's `orm`, built on Bun.sql), not
// in-memory Maps — connections/users/triggers/logs now survive a restart and are shared across processes
// (the API server and worker.ts both read/write the same database).
//
// Encryption boundary unchanged from the in-memory version: this file is still the ONLY place that knows
// `secrets` is ever encrypted — every caller elsewhere only ever sees a real Connection with real,
// decrypted `.secrets`. Internally the DB column is `secrets_encrypted` (text, opaque base64), never a
// plaintext/jsonb column — see src/db/schema.ts's comment on why not jsonb specifically.

import { eq, desc } from "drizzle-orm";
import { orm } from "../lib/postgres";
import { users as usersTable, connections as connectionsTable, triggerInstances as triggerInstancesTable, actionLogs as actionLogsTable, triggerLogs as triggerLogsTable } from "../db/schema";
import { encrypt, decrypt } from "../lib/cipher";
import type { Connection, Secrets, User, UserId, ConnectionId, TriggerInstance, ActionLogEntry, TriggerLogEntry } from "../types";

function connectionRowToConnection(row: typeof connectionsTable.$inferSelect): Connection {
  return {
    connection_id: row.connection_id,
    user_id: row.user_id,
    app: row.app,
    status: row.status as Connection["status"],
    secrets: row.secrets_encrypted ? (JSON.parse(decrypt(row.secrets_encrypted)) as Secrets) : null,
    extra_metadata: row.extra_metadata as Record<string, unknown>,
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
  async listByUser(userId: UserId): Promise<Connection[]> {
    const rows = await orm.select().from(connectionsTable).where(eq(connectionsTable.user_id, userId));
    return rows.map(connectionRowToConnection);
  },
  async listAll(): Promise<Connection[]> {
    const rows = await orm.select().from(connectionsTable);
    return rows.map(connectionRowToConnection);
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

export const triggerLogStore = {
  async append(entry: TriggerLogEntry): Promise<void> {
    await orm.insert(triggerLogsTable).values(entry);
  },
  async listRecent(limit: number): Promise<TriggerLogEntry[]> {
    const rows = await orm.select().from(triggerLogsTable).orderBy(desc(triggerLogsTable.ran_at)).limit(limit);
    return rows.map((row) => ({
      log_id: row.log_id,
      trigger_instance_id: row.trigger_instance_id,
      connection_id: row.connection_id,
      user_id: row.user_id,
      app: row.app,
      trigger_key: row.trigger_key,
      status: row.status as TriggerLogEntry["status"],
      ran_at: row.ran_at,
      error: row.error ?? undefined,
    }));
  },
};

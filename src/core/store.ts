// Phase 1 storage. Deliberately the dumbest thing that works so Phase 1 can be exercised end-to-end
// before Phase 4 swaps this for Postgres (src/lib/postgres.ts) + Redis (src/lib/redis.ts) — both clients
// already exist, just not called from here yet. S3 (src/lib/s3.ts) has no confirmed use in this store
// at all — see that file's TODO before assuming object storage belongs anywhere in the user/connection path.
//
// Real (not stubbed) in-memory implementation — dies on restart, that's the accepted trade-off for Phase
// 1-3 dev velocity. TODO(ask): swap for bun:sqlite (per CLAUDE.md) as a stepping stone that survives a
// restart, before Phase 4's real Postgres migration — the interface below doesn't change either way.

import type { Connection, Secrets, User, UserId, ConnectionId, TriggerInstance, ActionLogEntry } from "../types";
import { encrypt, decrypt } from "../lib/cipher";

const users = new Map<UserId, User>();
// Internally stores secrets ENCRYPTED (as an opaque base64 string, or null) — everything outside this
// file only ever sees a real Connection with real .secrets, per the boundary described in cipher.ts and
// types.ts's Connection.secrets comment.
type StoredConnection = Omit<Connection, "secrets"> & { secrets_encrypted: string | null };
const connections = new Map<ConnectionId, StoredConnection>();
const triggerInstances = new Map<string, TriggerInstance>();
// TODO(ask): action logs will grow unbounded in a Map — cap at N most recent (ring buffer), or is that a
// Phase 4 (real DB) concern and Phase 1-3's in-memory version is allowed to just leak until restart?
const actionLogs: ActionLogEntry[] = [];

function toStored(connection: Connection): StoredConnection {
  const { secrets, ...rest } = connection;
  return { ...rest, secrets_encrypted: secrets ? encrypt(JSON.stringify(secrets)) : null };
}

function fromStored(stored: StoredConnection): Connection {
  const { secrets_encrypted, ...rest } = stored;
  return { ...rest, secrets: secrets_encrypted ? (JSON.parse(decrypt(secrets_encrypted)) as Secrets) : null };
}

export const userStore = {
  async create(user: User): Promise<void> {
    users.set(user.user_id, user);
  },
  async get(userId: UserId): Promise<User | null> {
    return users.get(userId) ?? null;
  },
  async listAll(): Promise<User[]> {
    return [...users.values()];
  },
};

export const connectionStore = {
  async create(connection: Connection): Promise<void> {
    connections.set(connection.connection_id, toStored(connection));
  },
  async get(connectionId: ConnectionId): Promise<Connection | null> {
    const stored = connections.get(connectionId);
    return stored ? fromStored(stored) : null;
  },
  async update(connectionId: ConnectionId, patch: Partial<Connection>): Promise<void> {
    const existing = connections.get(connectionId);
    if (!existing) {
      throw new Error(`Cannot update unknown connection: ${connectionId}`);
    }
    // `"secrets" in patch` (not `patch.secrets !== undefined`) so patching secrets to `null` on purpose
    // (e.g. a future "disconnect" flow clearing them) is distinguishable from "this patch doesn't touch
    // secrets at all" — the latter must leave secrets_encrypted untouched, not overwrite it with null.
    const secretsPatch = "secrets" in patch ? { secrets_encrypted: patch.secrets ? encrypt(JSON.stringify(patch.secrets)) : null } : {};
    const { secrets, ...restPatch } = patch;
    connections.set(connectionId, { ...existing, ...restPatch, ...secretsPatch });
  },
  async listByUser(userId: UserId): Promise<Connection[]> {
    return [...connections.values()].filter((c) => c.user_id === userId).map(fromStored);
  },
  async listAll(): Promise<Connection[]> {
    return [...connections.values()].map(fromStored);
  },
};

export const triggerInstanceStore = {
  async create(instance: TriggerInstance): Promise<void> {
    triggerInstances.set(instance.trigger_instance_id, instance);
  },
  async listActive(): Promise<TriggerInstance[]> {
    return [...triggerInstances.values()].filter((t) => t.status === "active");
  },
};

export const actionLogStore = {
  async append(entry: ActionLogEntry): Promise<void> {
    actionLogs.push(entry);
  },
  async listRecent(limit: number): Promise<ActionLogEntry[]> {
    return actionLogs.slice(-limit).reverse();
  },
};

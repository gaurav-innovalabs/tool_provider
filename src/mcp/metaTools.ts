// Real implementations (not stubs) for every Phase-MCP meta-tool. Each one is additive — it calls the
// same core/store.ts + core/registry.ts + lib/*.ts functions the existing REST routes call, but nothing
// here is imported BY those routes and nothing here imports FROM src/api/*_routes.ts. Kept side-by-side
// on purpose (see MCP_GUIDE.md's "why a separate layer, not new REST routes" section) — the REST API and
// the MCP server are two front doors onto the same core, not one wrapping the other.

import { connectionStore, actionLogStore, triggerInstanceStore } from "../core/store";
import { getApp, listApps } from "../core/registry";
import { ensureFreshConnection } from "../core/tokenRefresh";
import { PENDING_CONNECTION_TTL_MS } from "../core/connectionExpiry";
import { createConnectToken } from "../lib/redis";
import { config } from "../config";
import type { Connection } from "../types";
import { z } from "zod";
import type {
  searchToolsInput,
  searchToolsOutput,
  manageConnectionInput,
  manageConnectionOutput,
  executeToolInput,
  executeToolOutput,
  waitForConnectionInput,
  waitForConnectionOutput,
  getToolSchemaInput,
  getToolSchemaOutput,
  listTriggersOutput,
  subscribeTriggerInput,
  subscribeTriggerOutput,
} from "./types";

// `null` = no restriction (every app in the registry is visible/callable), matching every session before
// this existed. A non-null array is an allow-list resolved once per session — stdio's MCP_APPS env var,
// or the optional `apps` field on the /mcp/login form (see src/mcp/server.ts / src/api/mcp_routes.ts).
export type AppScope = string[] | null;

function assertAppAllowed(appId: string, scope: AppScope): void {
  if (scope && !scope.includes(appId)) {
    throw new Error(`App "${appId}" is outside this session's scope (allowed: ${scope.join(", ")})`);
  }
}

function scopedApps(scope: AppScope) {
  const apps = listApps();
  return scope ? apps.filter((a) => scope.includes(a.id)) : apps;
}

// --- search_tools -----------------------------------------------------------------------------------
// Keyword match over the registry, per mcp-connect-flow.md's "not worth real semantic search at ~10
// actions" call. Revisit (embeddings, or at least a real ranking lib) only once the action count actually
// makes this matter — same "don't build for scale we don't have" discipline as components/TODO.md.

export function searchTools(input: z.infer<typeof searchToolsInput>, scope: AppScope): z.infer<typeof searchToolsOutput> {
  const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = scopedApps(scope).flatMap((app) =>
    app.actions.map((action) => {
      const haystack = `${app.id} ${app.name} ${action.key} ${action.description}`.toLowerCase();
      const score = words.filter((w) => haystack.includes(w)).length;
      return { app: app.id, action: action.key, description: action.description, score };
    }),
  );

  const tools = scored
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ app, action, description }) => ({ app, action, description }));

  // No matches at all: return everything rather than an empty list — with ~10 actions total, an empty
  // result on a query typo is worse than a short list the agent can skim. Revisit once app count grows.
  return { tools: tools.length > 0 ? tools : scored.map(({ app, action, description }) => ({ app, action, description })) };
}

// --- shared: get-or-create a connection --------------------------------------------------------------
// Same three states POST /connections already produces (connection_routes.ts) for oauth2/api_key apps —
// duplicated here deliberately rather than imported from connection_routes.ts, which exports a Bun route
// handler (Request -> Response), not a callable function. Factor out a shared core/connections.ts helper
// if a third caller ever needs this same logic — not worth it for two call sites yet.
async function getOrCreateActiveConnection(
  userId: string,
  appId: string,
  scope: AppScope,
): Promise<{ status: "active"; connection: Connection } | { status: "pending"; connection_id: string; connect_url: string }> {
  assertAppAllowed(appId, scope);
  const app = getApp(appId); // throws Unknown app — let the caller's try/catch turn this into an MCP tool error

  const existing = (await connectionStore.listByUser(userId)).find((c) => c.app === appId && c.status === "active");
  if (existing) {
    return { status: "active", connection: existing };
  }

  const connection_id = `conn_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  if (app.auth.type === "none") {
    const connection: Connection = { connection_id, user_id: userId, app: appId, status: "active", secrets: null, extra_metadata: {}, expires_at: null, created_at: now, updated_at: now };
    await connectionStore.create(connection);
    return { status: "active", connection };
  }

  // oauth2 / api_key / custom — same "pending row + connect token" shape as POST /connections.
  await connectionStore.create({
    connection_id,
    user_id: userId,
    app: appId,
    status: "pending",
    secrets: null,
    extra_metadata: {},
    expires_at: new Date(Date.now() + PENDING_CONNECTION_TTL_MS).toISOString(),
    created_at: now,
    updated_at: now,
  });
  const token = await createConnectToken(connection_id);
  return { status: "pending", connection_id, connect_url: `${config.BASE_URL}/connect/${token}` };
}

// --- manage_connection --------------------------------------------------------------------------------

export async function manageConnection(userId: string, input: z.infer<typeof manageConnectionInput>, scope: AppScope): Promise<z.infer<typeof manageConnectionOutput>> {
  const result = await getOrCreateActiveConnection(userId, input.app, scope);
  if (result.status === "active") {
    return { status: "active", connection_id: result.connection.connection_id };
  }
  return { status: "pending", connection_id: result.connection_id, connect_url: result.connect_url };
}

// --- wait_for_connection -------------------------------------------------------------------------------
// Honest polling, not a real push notification — nothing in this project gets told "the user finished
// OAuth" other than the callback itself flipping the row to active (webhook_routes.ts). 3s between checks:
// frequent enough to feel responsive in an agent conversation, far too infrequent to be a real load
// concern against our own database.
const WAIT_FOR_CONNECTION_POLL_MS = 3_000;

export async function waitForConnection(userId: string, input: z.infer<typeof waitForConnectionInput>): Promise<z.infer<typeof waitForConnectionOutput>> {
  const deadline = Date.now() + input.timeout_ms;

  while (true) {
    const connection = await connectionStore.get(input.connection_id);
    if (!connection || connection.user_id !== userId) {
      throw new Error(`Unknown connection: ${input.connection_id}`);
    }
    if (connection.status === "active") {
      return { status: "active", connection_id: input.connection_id };
    }
    if (connection.status === "revoked" || connection.status === "error" || connection.status === "expired") {
      return { status: "failed", connection_id: input.connection_id, current_status: connection.status };
    }
    if (Date.now() >= deadline) {
      return { status: "timeout", connection_id: input.connection_id, current_status: connection.status };
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_CONNECTION_POLL_MS));
  }
}

// --- execute_tool ----------------------------------------------------------------------------------
// Mirrors action_routes.ts's POST /actions/:app/:action dispatch (input/output zod validation,
// ensureFreshConnection, actionLogStore) almost line for line — the one real difference is the
// not-connected case: action_routes.ts 409s, this returns a normal `status: "not_connected"` result
// carrying a connect_url instead, per mcp-connect-flow.md's confirmed Composio/Pipedream pattern.

export async function executeTool(userId: string, input: z.infer<typeof executeToolInput>, scope: AppScope): Promise<z.infer<typeof executeToolOutput>> {
  assertAppAllowed(input.app, scope);
  const app = getApp(input.app);
  const action = app.actions.find((a) => a.key === input.action);
  if (!action) {
    throw new Error(`Unknown action: ${input.app}.${input.action}`);
  }

  const resolved = await getOrCreateActiveConnection(userId, input.app, scope);
  if (resolved.status === "pending") {
    return { status: "not_connected", connection_id: resolved.connection_id, connect_url: resolved.connect_url };
  }

  const startedAt = Date.now();
  const freshConnection = await ensureFreshConnection(app, resolved.connection);
  try {
    const parsedInput = action.input.parse(input.input);
    const result = await action.run(freshConnection, parsedInput);
    const parsedOutput = action.output.parse(result);

    await actionLogStore.append({
      log_id: crypto.randomUUID(),
      connection_id: freshConnection.connection_id,
      user_id: userId,
      app: input.app,
      action_key: input.action,
      status: "success",
      called_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
    });

    return { status: "ok", result: parsedOutput };
  } catch (err) {
    await actionLogStore.append({
      log_id: crypto.randomUUID(),
      connection_id: freshConnection.connection_id,
      user_id: userId,
      app: input.app,
      action_key: input.action,
      status: "error",
      called_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err; // let src/mcp/server.ts's handler wrap this as an MCP tool error result — see its TODO
  }
}

// --- get_tool_schema -----------------------------------------------------------------------------------
// z.toJSONSchema is zod v4's own converter (already a dependency) — src/openapi.ts uses the same function
// for the REST API's /openapi.json, so this is the same schema shape a caller would get from either front
// door, not a second bespoke conversion.

export function getToolSchema(input: z.infer<typeof getToolSchemaInput>, scope: AppScope): z.infer<typeof getToolSchemaOutput> {
  assertAppAllowed(input.app, scope);
  const app = getApp(input.app);
  const action = app.actions.find((a) => a.key === input.action);
  if (!action) {
    throw new Error(`Unknown action: ${input.app}.${input.action}`);
  }
  return {
    app: input.app,
    action: input.action,
    description: action.description,
    input_schema: z.toJSONSchema(action.input),
    output_schema: z.toJSONSchema(action.output),
  };
}

// --- list_triggers / subscribe_trigger ------------------------------------------------------------------
// Mirrors GET /triggers and POST /triggers/:app/:trigger/subscribe (trigger_routes.ts) — same registry
// read, same TriggerInstance shape — but subscribe_trigger resolves the connection from `user_id` + `app`
// (via the same get-or-create helper execute_tool uses) instead of requiring the caller to already have a
// connection_id, matching this MCP layer's "user_id-first" model rather than trigger_routes.ts's
// connection_id-first REST contract.

// Matches trigger_routes.ts's own floor — kept in sync by convention, not by import (that file's constant
// isn't exported; not worth adding an export for one shared number across two call sites).
const MIN_POLL_INTERVAL_MS = 60 * 1000;

export function listTriggers(scope: AppScope): z.infer<typeof listTriggersOutput> {
  const triggers = scopedApps(scope).flatMap((app) =>
    app.triggers.map((t) => ({
      app: app.id,
      trigger: t.key,
      description: t.description,
      mode: t.mode,
      default_poll_interval_ms: t.defaultPollIntervalMs ?? null,
    })),
  );
  return { triggers };
}

export async function subscribeTrigger(userId: string, input: z.infer<typeof subscribeTriggerInput>, scope: AppScope): Promise<z.infer<typeof subscribeTriggerOutput>> {
  assertAppAllowed(input.app, scope);
  const app = getApp(input.app);
  const trigger = app.triggers.find((t) => t.key === input.trigger);
  if (!trigger) {
    throw new Error(`Unknown trigger: ${input.app}.${input.trigger}`);
  }
  if (input.poll_interval_ms !== undefined && input.poll_interval_ms < MIN_POLL_INTERVAL_MS) {
    throw new Error(`poll_interval_ms must be at least ${MIN_POLL_INTERVAL_MS}`);
  }

  const resolved = await getOrCreateActiveConnection(userId, input.app, scope);
  if (resolved.status === "pending") {
    return { status: "not_connected", connection_id: resolved.connection_id, connect_url: resolved.connect_url };
  }

  const poll_interval_ms = trigger.mode === "poll" ? (input.poll_interval_ms ?? trigger.defaultPollIntervalMs ?? null) : null;
  const trigger_instance_id = `ti_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await triggerInstanceStore.create({
    trigger_instance_id,
    connection_id: resolved.connection.connection_id,
    user_id: userId,
    app: input.app,
    trigger_key: input.trigger,
    status: "active",
    webhook_url: input.webhook_url,
    poll_interval_ms,
    cursor: null,
    created_at: now,
    updated_at: now,
  });

  return { status: "subscribed", trigger_instance_id, poll_interval_ms };
}

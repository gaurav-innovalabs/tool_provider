// Meta-tool I/O contracts for Phase-MCP-1. Deliberately three tools, not one per Action — see
// docs/research/mcp-connect-flow.md for why (Composio/Pipedream both converge on this shape).
// Zod schemas double as the MCP `inputSchema`/`outputSchema` the SDK wants (registerTool takes a raw
// zod shape, not a JSON-schema object) and as the runtime validation at the same boundary action_routes.ts
// already enforces for the REST API — same discipline, new surface.

import { z } from "zod";

export const searchToolsInput = z.object({
  query: z.string().describe("Free-text description of what you're trying to do, e.g. 'send an email' or 'search the web'"),
});

export const searchToolsOutputTool = z.object({
  app: z.string(),
  action: z.string(), // action.key — pass straight through to execute_tool's `action` field
  description: z.string(),
});

export const searchToolsOutput = z.object({
  tools: z.array(searchToolsOutputTool),
});

export const manageConnectionInput = z.object({
  app: z.string().describe("App id, e.g. 'gmail', 'slack', 'serpapi' — see search_tools results for valid values"),
});

// --- list_connections ----------------------------------------------------------------------------------
// ~ Composio's GET /connected_accounts (filtered to the current session's user). Mirrors REST's
// GET /connections?user_id=&app= (connection_routes.ts) — closes the same "no way to see what you've
// already connected" gap on the MCP side, not just REST.

export const listConnectionsInput = z.object({
  app: z.string().optional().describe("Narrow to one app's connections, e.g. 'gmail'. Omit to list every app."),
});

export const listConnectionsOutputConnection = z.object({
  connection_id: z.string(),
  app: z.string(),
  status: z.enum(["pending", "active", "revoked", "error", "expired"]),
  extra_metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});

export const listConnectionsOutput = z.object({
  connections: z.array(listConnectionsOutputConnection),
});

// One flat object, not z.discriminatedUnion — the MCP SDK's registerTool silently drops `outputSchema`
// (and the resulting `structuredContent`) for a schema whose top-level JSON Schema isn't a plain object
// (a union/discriminatedUnion converts to `oneOf`, which it rejects) — confirmed live: tools/list showed
// outputSchema:absent and the client got structuredContent:undefined until this was flattened. Same two
// real states POST /connections already returns for oauth2/api_key apps (connection_routes.ts) — "active"
// (already usable) or "pending" (hand connect_url to the end user) — just carried as one object with
// `connect_url` optional instead of a second variant.
export const manageConnectionOutput = z.object({
  status: z.enum(["active", "pending"]),
  connection_id: z.string(),
  connect_url: z.string().optional(),
});

// --- disconnect_connection ------------------------------------------------------------------------------
// ~ REST's DELETE /connections/:id (connection_routes.ts) / Composio's DELETE /connected_accounts/{id} —
// closes the disconnect/revoke gap flagged in PHASES.md Phase 7: until now there was list_connections but
// no way to actually undo one. Real revoke, not cosmetic — clears `secrets` too, so a later
// manage_connection/execute_tool call on that app starts a genuinely fresh connect flow.

export const disconnectConnectionInput = z.object({
  connection_id: z.string().describe("From list_connections — the connection to disconnect"),
});

export const disconnectConnectionOutput = z.object({
  connection_id: z.string(),
  status: z.literal("revoked"),
});

export const executeToolInput = z.object({
  app: z.string(),
  action: z.string(), // action.key, from a prior search_tools call
  input: z.unknown().describe("The action's own input, matching its declared schema — call search_tools or the /openapi.json doc to see its shape"),
});

// Flat object (see manageConnectionOutput's comment on why, not a union) — a real action result, or — per
// the not-connected pattern in mcp-connect-flow.md — a normal (non-error) result carrying a connect_url
// instead of throwing. The calling agent is expected to surface `connect_url` conversationally and either
// call wait_for_connection or retry the same execute_tool call once the user finishes connecting.
export const executeToolOutput = z.object({
  status: z.enum(["ok", "not_connected"]),
  result: z.unknown().optional(),
  connection_id: z.string().optional(),
  connect_url: z.string().optional(),
});

// --- wait_for_connection ------------------------------------------------------------------------------
// Fills the gap left by manage_connection/execute_tool only ever returning a connect_url once — without
// this, an agent has no way to know when the user actually finished the browser flow other than blindly
// re-calling execute_tool. Polls the same connectionStore row every trigger's poll cadence would (a plain
// `SELECT`, not a webhook — we don't get pushed a "user finished" event from any provider), matches
// Composio's `session.authorize().waitForConnection()` helper in shape (block until active or timeout),
// not in mechanism (they likely have a real completion event; we don't, so this is honest polling).

export const waitForConnectionInput = z.object({
  connection_id: z.string().describe("The connection_id returned by manage_connection or a not_connected execute_tool result"),
  timeout_ms: z.number().int().positive().max(10 * 60 * 1000).default(120_000).describe("Give up after this long. Default 2 minutes, max 10."),
});

// Flat object (see manageConnectionOutput's comment on why, not a union). `failed` is surfaced distinctly
// from `timeout` so the agent doesn't just tell the user "still waiting" forever on a connection that
// declined/errored mid-flow and is never going to become active on its own.
export const waitForConnectionOutput = z.object({
  status: z.enum(["active", "timeout", "failed"]),
  connection_id: z.string(),
  current_status: z.string().optional(),
});

// --- get_tool_schema -----------------------------------------------------------------------------------
// search_tools only returns a one-line description — not enough to call execute_tool with confidence on
// anything beyond the simplest actions. This is Composio's separate schema-lookup meta-tool
// (docs/research/mcp-connect-flow.md), backed here by zod v4's native `z.toJSONSchema()` — no extra dependency,
// same converter src/openapi.ts already uses for the REST API's /openapi.json.

export const getToolSchemaInput = z.object({
  app: z.string(),
  action: z.string(),
});

export const getToolSchemaOutput = z.object({
  app: z.string(),
  action: z.string(),
  description: z.string(),
  input_schema: z.unknown(), // JSON Schema (z.toJSONSchema output) — shape varies per action, not worth a zod schema of a zod schema
  output_schema: z.unknown(),
});

// --- list_triggers / subscribe_trigger ------------------------------------------------------------------
// Triggers (Gmail polling, Slack webhooks — src/core/scheduler.ts, real and running since Phase 3) existed
// only via the REST API until now; these two mirror GET /triggers and POST /triggers/:app/:trigger/subscribe
// so an MCP agent can set up event delivery the same way it can call an action, without dropping to curl.

export const listTriggersOutputTrigger = z.object({
  app: z.string(),
  trigger: z.string(),
  description: z.string(),
  mode: z.enum(["poll", "webhook"]),
  default_poll_interval_ms: z.number().nullable(),
});

export const listTriggersOutput = z.object({
  triggers: z.array(listTriggersOutputTrigger),
});

// 4096 bytes — same MAX_EXTRA_METADATA_BYTES cap as trigger_routes.ts (TODO(ask) there on the exact
// number); kept as a literal here rather than imported since this file has zero imports from src/api/* by
// design (see metaTools.ts's header comment on the two layers being deliberately side-by-side).
const extraMetadataSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= 4096, { message: "extra_metadata must serialize to 4096 bytes or fewer" })
  .optional()
  .describe("Opaque client space, e.g. { notes: '...' } — never read/interpreted by us. Editable later via REST PATCH /triggers/:id (no MCP tool for that yet, TODO(ask) below).");

export const subscribeTriggerInput = z.object({
  app: z.string(),
  trigger: z.string(), // trigger.key, from a prior list_triggers call
  webhook_url: z.string().url().describe("Where we POST each event once this trigger fires"),
  poll_interval_ms: z.number().int().min(60_000).optional().describe("Only meaningful for poll-mode triggers; omit to use the trigger's own default"),
  extra_metadata: extraMetadataSchema,
});

// Flat object (see manageConnectionOutput's comment on why, not a union).
export const subscribeTriggerOutput = z.object({
  status: z.enum(["subscribed", "not_connected"]),
  trigger_instance_id: z.string().optional(),
  poll_interval_ms: z.number().nullable().optional(),
  connection_id: z.string().optional(),
  connect_url: z.string().optional(),
});

// --- list_trigger_instances -----------------------------------------------------------------------------
// ~ REST's GET /triggers/instances?user_id=&app= (trigger_routes.ts) — "which triggers have I actually
// subscribed to", distinct from list_triggers above (available trigger TYPES, not instances).
// TODO(ask): no MCP tool yet to edit a subscribed instance's extra_metadata after the fact (REST has
// PATCH /triggers/:id) — add update_trigger_metadata if an agent actually needs to revise notes on an
// existing subscription rather than just setting them once at subscribe_trigger time.

export const listTriggerInstancesInput = z.object({
  app: z.string().optional().describe("Narrow to one app's trigger instances. Omit to list every app."),
});

export const listTriggerInstancesOutputInstance = z.object({
  trigger_instance_id: z.string(),
  connection_id: z.string(),
  app: z.string(),
  trigger_key: z.string(),
  status: z.enum(["active", "paused", "error"]),
  webhook_url: z.string(),
  poll_interval_ms: z.number().nullable(),
  extra_metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});

export const listTriggerInstancesOutput = z.object({
  trigger_instances: z.array(listTriggerInstancesOutputInstance),
});

// --- list_trigger_logs / resend_trigger_webhook -----------------------------------------------------
// ~ REST's GET /triggers/instances/{id}/logs and POST /triggers/logs/{log_id}/resend (trigger_routes.ts).
// Stripe-CLI-`events list` / `events resend` shape: see what a trigger has actually fired (status, which
// webhook_url each attempt went to, the error if any), and replay one on demand. Ownership is enforced by
// `userId` (session-bound here, unlike REST's explicit `user_id` body/query field) matching the instance's
// own owner — same check trigger_routes.ts makes explicitly.

export const listTriggerLogsInput = z.object({
  trigger_instance_id: z.string().describe("From a prior list_trigger_instances call"),
  limit: z.number().int().positive().max(200).default(50).optional(),
});

export const listTriggerLogsOutputLog = z.object({
  log_id: z.string(),
  status: z.enum(["success", "error"]),
  ran_at: z.string(),
  error: z.string().optional(),
  webhook_url: z.string().optional(),
  // Mirrors REST's `resendable` field — presence of a captured payload is the actual signal, exposed as a
  // plain boolean so the calling agent doesn't have to know that.
  resendable: z.boolean(),
});

export const listTriggerLogsOutput = z.object({
  logs: z.array(listTriggerLogsOutputLog),
});

// --- get_trigger_log ---------------------------------------------------------------------------------
// ~ REST's GET /triggers/logs/{log_id} (~ Stripe's GET /v1/events/{id}). list_trigger_logs deliberately
// omits `payload`/`data` (same reasoning as REST's logs-list route) — this is the one call that actually
// returns an event's full body, keyed by the SAME `log_id` list_trigger_logs handed you (a delivery row's
// `log_id` IS its event id — scheduler.ts's deliverEvent/resendDelivery generate one id, used as both).

export const getTriggerLogInput = z.object({
  log_id: z.string().describe("A log_id from list_trigger_logs — this IS the event id for a delivery row"),
});

export const getTriggerLogOutput = z.object({
  log_id: z.string(),
  trigger_instance_id: z.string(),
  app: z.string(),
  trigger_key: z.string(),
  status: z.enum(["success", "error"]),
  ran_at: z.string(),
  error: z.string().optional(),
  webhook_url: z.string().optional(),
  payload: z.unknown().describe("The exact envelope delivered — {id, type, metadata, data, timestamp} — absent on a poll-attempt row"),
  resendable: z.boolean(),
});

export const resendTriggerWebhookInput = z.object({
  log_id: z.string().describe("A log_id from list_trigger_logs where resendable is true"),
});

export const resendTriggerWebhookOutput = z.object({
  log_id: z.string(), // the NEW log row created by the resend, not the original
  status: z.enum(["success", "error"]),
  ran_at: z.string(),
  webhook_url: z.string(),
  error: z.string().optional(),
});

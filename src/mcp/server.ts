// Phase-MCP-1: stdio MCP server. One process = one bound user_id, matching how Claude Desktop/Claude Code
// spawn a local MCP server ("command"/"args"/"env" in the client's mcp config) — see MCP_GUIDE.md for the
// exact client config. This is deliberately NOT the remote/multi-tenant server (Phase-MCP-2, see
// PHASES.md) — no HTTP, no per-request user_id, no Bearer auth. Auth here is "can you spawn this process
// with the right MCP_AUTH_KEY env var", checked once at startup, fail-closed.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "../config";
import {
  searchTools,
  manageConnection,
  listConnections,
  disconnectConnection,
  executeTool,
  waitForConnection,
  getToolSchema,
  listTriggers,
  subscribeTrigger,
  listTriggerInstances,
  listTriggerLogs,
  listRecentTriggerLogs,
  getTriggerLog,
  resendTriggerWebhook,
  type AppScope,
} from "./metaTools";
import {
  searchToolsInput,
  searchToolsOutput,
  manageConnectionInput,
  manageConnectionOutput,
  listConnectionsInput,
  listConnectionsOutput,
  disconnectConnectionInput,
  disconnectConnectionOutput,
  executeToolInput,
  executeToolOutput,
  waitForConnectionInput,
  waitForConnectionOutput,
  getToolSchemaInput,
  getToolSchemaOutput,
  listTriggersOutput,
  subscribeTriggerInput,
  subscribeTriggerOutput,
  listTriggerInstancesInput,
  listTriggerInstancesOutput,
  listTriggerLogsInput,
  listTriggerLogsOutput,
  listRecentTriggerLogsInput,
  listRecentTriggerLogsOutput,
  getTriggerLogInput,
  getTriggerLogOutput,
  resendTriggerWebhookInput,
  resendTriggerWebhookOutput,
} from "./types";

function requireEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`${name} is required to start the MCP server — set it in the MCP client's "env" config. See MCP_GUIDE.md.`);
  }
  return value;
}

// Wraps a handler so a thrown error becomes a normal MCP `isError:true` result instead of tearing down
// the session — see the TODO below on why isError over a protocol-level error for now.
function toolResult(promiseOrValue: unknown | Promise<unknown>) {
  return Promise.resolve(promiseOrValue).then(
    (result) => ({ content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> }),
    (err) => ({ content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true }),
  );
}

// Pure builder — no env reading, no auth check, just "one McpServer instance bound to this user_id (and
// optional app scope)" with every meta-tool registered. Shared by both transports: stdio's
// createMcpServer (one process = one user, checked once at startup below) and src/mcp/httpServer.ts (one
// process = many users, one McpServer instance per authenticated HTTP session — see that file for how a
// session gets its userId/scope).
export function buildMcpServer(userId: string, scope: AppScope = null): McpServer {
  const server = new McpServer({ name: "tool-provider-mcp", version: "0.2.0" });

  server.registerTool(
    "search_tools",
    {
      description: "Find available tools (app + action pairs) matching a free-text description of a task.",
      inputSchema: searchToolsInput.shape,
      outputSchema: searchToolsOutput,
    },
    (input) => toolResult(searchTools(input, scope)),
  );

  server.registerTool(
    "get_tool_schema",
    {
      description: "Get the full input/output JSON Schema for one action found via search_tools — use this before execute_tool on anything beyond the simplest inputs.",
      inputSchema: getToolSchemaInput.shape,
      outputSchema: getToolSchemaOutput,
    },
    (input) => toolResult(getToolSchema(input, scope)),
  );

  server.registerTool(
    "manage_connection",
    {
      description: "Check or start a connection to an app for the current user. Returns connect_url if the user needs to authenticate.",
      inputSchema: manageConnectionInput.shape,
      outputSchema: manageConnectionOutput,
    },
    (input) => toolResult(manageConnection(userId, input, scope)),
  );

  server.registerTool(
    "list_connections",
    {
      description: "List the current user's connections (optionally filtered by app) — what's already connected, and its status.",
      inputSchema: listConnectionsInput.shape,
      outputSchema: listConnectionsOutput,
    },
    (input) => toolResult(listConnections(userId, input, scope)),
  );

  server.registerTool(
    "disconnect_connection",
    {
      description: "Disconnect (revoke) one of the current user's connections. Clears the stored credentials; a later manage_connection/execute_tool call on that app starts a fresh connect flow.",
      inputSchema: disconnectConnectionInput.shape,
      outputSchema: disconnectConnectionOutput,
    },
    (input) => toolResult(disconnectConnection(userId, input, scope)),
  );

  server.registerTool(
    "wait_for_connection",
    {
      description: "Block until a pending connection (from manage_connection or execute_tool's not_connected result) becomes active, or times out. Use this instead of blindly retrying execute_tool.",
      inputSchema: waitForConnectionInput.shape,
      outputSchema: waitForConnectionOutput,
    },
    (input) => toolResult(waitForConnection(userId, input)),
  );

  server.registerTool(
    "execute_tool",
    {
      description: "Run one action (from search_tools) against the current user's connection to that app. If not connected, returns a connect_url instead of an error — surface it to the user, then call wait_for_connection or retry.",
      inputSchema: executeToolInput.shape,
      outputSchema: executeToolOutput,
    },
    (input) => toolResult(executeTool(userId, input, scope)),
  );

  server.registerTool(
    "list_triggers",
    {
      description: "List available event triggers (app + trigger pairs) that can be subscribed to.",
      outputSchema: listTriggersOutput,
    },
    () => toolResult(listTriggers(scope)),
  );

  server.registerTool(
    "subscribe_trigger",
    {
      description: "Subscribe the current user to an event trigger; events are POSTed to webhook_url as they occur. Returns connect_url if not yet connected to that app.",
      inputSchema: subscribeTriggerInput.shape,
      outputSchema: subscribeTriggerOutput,
    },
    (input) => toolResult(subscribeTrigger(userId, input, scope)),
  );

  server.registerTool(
    "list_trigger_instances",
    {
      description: "List the current user's subscribed trigger instances (optionally filtered by app) — distinct from list_triggers, which lists available trigger TYPES, not what's actually subscribed.",
      inputSchema: listTriggerInstancesInput.shape,
      outputSchema: listTriggerInstancesOutput,
    },
    (input) => toolResult(listTriggerInstances(userId, input, scope)),
  );

  server.registerTool(
    "list_trigger_logs",
    {
      description: "List what a subscribed trigger instance has actually fired — status, which webhook_url each attempt went to, the error if any, and whether it can be resent. Stripe-CLI 'events list' style.",
      inputSchema: listTriggerLogsInput.shape,
      outputSchema: listTriggerLogsOutput,
    },
    (input) => toolResult(listTriggerLogs(userId, input, scope)),
  );

  server.registerTool(
    "list_recent_trigger_logs",
    {
      description: "List everything that's fired recently across EVERY trigger the current user has subscribed to — not scoped to one instance like list_trigger_logs (which requires a trigger_instance_id). Use this for 'what happened recently' without already knowing which instance to check. Optional app filter.",
      inputSchema: listRecentTriggerLogsInput.shape,
      outputSchema: listRecentTriggerLogsOutput,
    },
    (input) => toolResult(listRecentTriggerLogs(userId, input, scope)),
  );

  server.registerTool(
    "get_trigger_log",
    {
      description: "Get one trigger event's full body, including its payload — list_trigger_logs deliberately omits payload; this is the one call that returns it. log_id IS the event id for a delivery row. Stripe 'GET /v1/events/{id}' style.",
      inputSchema: getTriggerLogInput.shape,
      outputSchema: getTriggerLogOutput,
    },
    (input) => toolResult(getTriggerLog(userId, input, scope)),
  );

  server.registerTool(
    "resend_trigger_webhook",
    {
      description: "Replay one already-fired trigger event (from list_trigger_logs, where resendable is true) — re-POSTs the exact same captured payload to the trigger instance's current webhook_url. Stripe-CLI 'events resend' style.",
      inputSchema: resendTriggerWebhookInput.shape,
      outputSchema: resendTriggerWebhookOutput,
    },
    (input) => toolResult(resendTriggerWebhook(userId, input, scope)),
  );

  return server;
}

// stdio-specific bootstrap: resolves userId/authKey/appScope from env (per mcp-connect-flow.md's "bound
// once at session/config time" pattern, implemented here as process-spawn env vars) and enforces the same
// unified bearer token the REST API and remote-MCP login enforce (src/lib/apiAuth.ts, src/api/mcp_routes.ts)
// — either ACCESS_TOKEN or ADMIN_ACCESS_TOKEN works. Kept as its own function (not folded into
// buildMcpServer) so buildMcpServer stays a pure, transport-agnostic builder.
export function createMcpServer(): McpServer {
  const userId = requireEnv("MCP_USER_ID");
  const authKey = requireEnv("MCP_AUTH_KEY");

  if (authKey !== config.security.ACCESS_TOKEN && authKey !== config.security.ADMIN_ACCESS_TOKEN) {
    throw new Error("MCP_AUTH_KEY does not match the server's configured ACCESS_TOKEN/ADMIN_ACCESS_TOKEN — refusing to start.");
  }

  // Optional: "gmail,slack" restricts this session's tools to those apps only (src/mcp/metaTools.ts's
  // AppScope). Unset = every app in the registry, same as before this existed.
  const rawApps = Bun.env.MCP_APPS?.trim();
  const scope: AppScope = rawApps ? rawApps.split(",").map((a) => a.trim()).filter(Boolean) : null;

  return buildMcpServer(userId, scope);
}

export async function startMcpServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// TODO(ask): MCP-protocol-level error vs. isError:true content for a failed tool call — currently
// isError:true for every meta-tool (toolResult() above), keeps the session alive instead of tearing down
// on one bad call. Needs a real client's behavior to confirm this is the right default long-term.

// Phase-MCP-2 (remote/multi-tenant HTTP + browser login) lives in src/mcp/httpServer.ts + src/api/mcp_routes.ts.

// Action dispatch — Composio-standard shape (confirmed against .idea/composio.http's real v3 API):
// ONE generic execute path keyed by a flat `tool_slug` (`GMAIL_LIST_RECENT_EMAILS`, not two path segments),
// plus two discovery routes (`GET /actions` ~ their `/tools`, `GET /actions/:tool_slug` ~ their
// `/tools/{slug}`) instead of exploding one hand-shaped OpenAPI path per action (src/openapi.ts used to do
// that — see its header comment; that's what generated the bloated /openapi.json this file's route shape
// now avoids). Validates input against the action's declared `input` schema, runs it, validates the result
// against `output` (a cheap correctness check on our own action code, not just a formality), and logs every
// call (success or failure) so /admin/logs is populated.

import { z } from "zod";
import { connectionStore, actionLogStore } from "../core/store";
import { findByToolSlug, listApps, toolSlug } from "../core/registry";
import { ensureFreshConnection } from "../core/tokenRefresh";
import type { ActionDefinition } from "../types";

const requestBody = z.object({
  connection_id: z.string(),
  input: z.unknown(),
});

export const actionRoutes = {
  // GET /actions?q=<free text> — search/list, mirrors Composio's GET /tools + MCP's search_tools (no
  // per-action schema here, just enough to pick a tool_slug; call GET /actions/:tool_slug for the schema).
  "/actions": {
    GET: async (req: Request) => {
      const q = new URL(req.url).searchParams.get("q")?.toLowerCase().trim();
      const words = q ? q.split(/\s+/).filter(Boolean) : [];

      const tools = listApps().flatMap((app) =>
        (app.actions as ActionDefinition[]).map((action) => ({
          tool_slug: toolSlug(app.id, action.key),
          app: app.id,
          action: action.key,
          description: action.description,
        })),
      );

      if (words.length === 0) {
        return Response.json({ tools });
      }
      const filtered = tools.filter((t) => {
        const haystack = `${t.tool_slug} ${t.description}`.toLowerCase();
        return words.every((w) => haystack.includes(w));
      });
      return Response.json({ tools: filtered });
    },
  },

  // GET /actions/:tool_slug — schema for one tool, mirrors Composio's GET /tools/{slug} and MCP's
  // get_tool_schema. Single generic path — not one path per action.
  "/actions/:tool_slug": {
    GET: async (req: Request & { params: { tool_slug: string } }) => {
      const found = findByToolSlug(req.params.tool_slug);
      if (!found) {
        return Response.json({ error: `Unknown tool_slug: ${req.params.tool_slug}` }, { status: 404 });
      }
      const { app, action } = found;
      return Response.json({
        tool_slug: toolSlug(app.id, action.key),
        app: app.id,
        action: action.key,
        description: action.description,
        input_schema: z.toJSONSchema(action.input),
        output_schema: z.toJSONSchema(action.output),
      });
    },
  },

  // POST /actions/execute/:tool_slug — the one execute path, ~ Composio's POST /tools/execute/{tool_slug}.
  "/actions/execute/:tool_slug": {
    POST: async (req: Request & { params: { tool_slug: string } }) => {
      const startedAt = Date.now();
      let connectionId: string | undefined;
      let userId = "unknown";

      const found = findByToolSlug(req.params.tool_slug);
      if (!found) {
        return Response.json({ error: `Unknown tool_slug: ${req.params.tool_slug}` }, { status: 404 });
      }
      const { app, action } = found;

      try {
        const body = requestBody.parse(await req.json());
        connectionId = body.connection_id;

        const connection = await connectionStore.get(connectionId);
        if (!connection) {
          return Response.json({ error: `Unknown connection: ${connectionId}` }, { status: 404 });
        }
        if (connection.status !== "active") {
          return Response.json({ error: `Connection ${connectionId} is not active (status: ${connection.status})` }, {
            status: 409,
          });
        }
        userId = connection.user_id;

        // Refresh-ahead-of-expiry (src/core/tokenRefresh.ts) — a no-op for api_key connections or any
        // oauth2 token not close to expiry; returns the connection as-is in either case.
        const freshConnection = await ensureFreshConnection(app, connection);

        // 400 on bad input — this is the "input props" contract actually being enforced, not just documented.
        const parsedInput = action.input.parse(body.input);
        const result = await action.run(freshConnection, parsedInput);
        // Validates our own action's return value against its declared `output` schema — catches an
        // action lying about its own contract, not just bad caller input.
        const parsedOutput = action.output.parse(result);

        await actionLogStore.append({
          log_id: crypto.randomUUID(),
          connection_id: connectionId,
          user_id: userId,
          app: app.id,
          action_key: action.key,
          status: "success",
          called_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
        });

        return Response.json(parsedOutput);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof z.ZodError ? 400 : 500;

        if (connectionId) {
          await actionLogStore.append({
            log_id: crypto.randomUUID(),
            connection_id: connectionId,
            user_id: userId,
            app: app.id,
            action_key: action.key,
            status: "error",
            called_at: new Date().toISOString(),
            duration_ms: Date.now() - startedAt,
            error: message,
          });
        }

        return Response.json({ error: message }, { status });
      }
    },
  },
};

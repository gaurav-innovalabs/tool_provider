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
import { formatError, errorResponse } from "../lib/errors";

const requestBody = z.object({
  connection_id: z.string(),
  input: z.unknown(),
});

export const actionRoutes = {
  // GET /apps — toolkit-level list, mirrors Composio's GET /toolkits. Lightweight (no actions/schemas
  // inlined) — an agent starts here to pick an app_slug, then calls GET /actions?app_slug=... below. Closes
  // the "no app-level route yet" gap noted at the top of tool_provider.http's comparison section.
  "/apps": {
    GET: async () => {
      const apps = listApps().map((app) => ({
        app_slug: app.id,
        name: app.name,
        auth_type: app.auth.type,
        action_count: app.actions.length,
        trigger_count: app.triggers.length,
      }));
      return Response.json({ apps });
    },
  },

  // GET /actions?q=<free text>&app_slug=<app> — search/list, mirrors Composio's GET /tools + MCP's
  // search_tools (no per-action schema here, just enough to pick a tool_slug; call GET /actions/:tool_slug
  // for the schema). Requires q or app_slug — dumping every action across every app isn't useful to a
  // caller/agent and only gets worse as more apps are registered; GET /apps above is the entry point for
  // "what apps exist", this is the entry point for "what actions does one app (or a keyword) match".
  "/actions": {
    GET: async (req: Request) => {
      const params = new URL(req.url).searchParams;
      const q = params.get("q")?.toLowerCase().trim();
      const appSlug = params.get("app_slug")?.toLowerCase().trim();
      const words = q ? q.split(/\s+/).filter(Boolean) : [];

      if (words.length === 0 && !appSlug) {
        return Response.json(
          { error: "Pass ?q=<search term> or ?app_slug=<app> — see GET /apps for the list of app_slug values." },
          { status: 400 },
        );
      }

      const apps = appSlug ? listApps().filter((app) => app.id.toLowerCase() === appSlug) : listApps();
      const tools = apps.flatMap((app) =>
        (app.actions as ActionDefinition[]).map((action) => ({
          tool_slug: toolSlug(app.id, action.key),
          app: app.id,
          action: action.key,
          description: action.description,
        })),
      );

      const filtered = words.length === 0
        ? tools
        : tools.filter((t) => {
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
        // The audit trail (action_logs, /admin/logs — admin-gated) always gets the FULL formatted message,
        // regardless of status — that's exactly the place a developer should be able to see the real
        // detail. The HTTP response to the caller goes through errorResponse() instead, which additionally
        // sanitizes a raw database driver error (never leak SQL/params to a client) and unconditionally
        // logs every 5xx server-side — see src/lib/errors.ts's header comment.
        const message = formatError(err);

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

        return errorResponse(err);
      }
    },
  },
};

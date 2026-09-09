// Action dispatch — validates input against the action's declared `input` schema, runs it, validates the
// result against `output` (a cheap correctness check on our own action code, not just a formality), and
// logs every call (success or failure) so /admin/logs is populated.

import { z } from "zod";
import { connectionStore, actionLogStore } from "../core/store";
import { getApp } from "../core/registry";
import { ensureFreshConnection } from "../core/tokenRefresh";

const requestBody = z.object({
  connection_id: z.string(),
  input: z.unknown(),
});

export const actionRoutes = {
  "/actions/:app/:action": {
    POST: async (req: Request & { params: { app: string; action: string } }) => {
      const startedAt = Date.now();
      let connectionId: string | undefined;
      let userId = "unknown";

      try {
        const body = requestBody.parse(await req.json());
        connectionId = body.connection_id;

        const app = getApp(req.params.app);
        const action = app.actions.find((a) => a.key === req.params.action);
        if (!action) {
          return Response.json({ error: `Unknown action: ${req.params.app}.${req.params.action}` }, { status: 404 });
        }

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
          app: req.params.app,
          action_key: req.params.action,
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
            app: req.params.app,
            action_key: req.params.action,
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

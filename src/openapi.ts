// OpenAPI 3.0 spec for the tool_provider API. Hand-written for the routes that don't change often
// (users/connections/admin), but the `/actions/{app}/{key}` entries are GENERATED from the real
// ActionDefinition.input/output zod schemas in src/components/*/actions/*.ts via zod's native
// `z.toJSONSchema()` (zod v4+, no extra dependency) — so action docs cannot drift out of sync with the
// actual code the way hand-duplicated schemas would. If you add/change an action, this file updates
// itself; nothing here needs editing for that.
//
// See requests.http for a Composio-API-reference comparison of what's implemented, missing, and extra
// relative to Composio's real v3 API (fetched from https://backend.composio.dev/api/v3/openapi.json).

import { z } from "zod";
import { listApps } from "./core/registry";
import type { ActionDefinition } from "./types";

function actionPaths() {
  const paths: Record<string, unknown> = {};
  for (const app of listApps()) {
    for (const action of app.actions as ActionDefinition[]) {
      paths[`/actions/${app.id}/${action.key}`] = {
        post: {
          tags: ["actions"],
          summary: `${app.name}: ${action.description}`,
          description: `Runs \`${app.id}.${action.key}\`. \`input\` is validated against this action's real zod schema (shown below) before it runs, and the result is validated against its output schema before it's returned.`,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    connection_id: { type: "string", description: `Must be an active connection to "${app.id}".` },
                    input: z.toJSONSchema(action.input),
                  },
                  required: ["connection_id", "input"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Action result, matching this action's real output schema.",
              content: { "application/json": { schema: z.toJSONSchema(action.output) } },
            },
            "400": { description: "Input failed this action's schema." },
            "404": { description: "Unknown connection_id." },
            "409": { description: "Connection exists but isn't active yet." },
            "500": { description: "The action ran but the underlying API call failed (message includes the provider's real error)." },
          },
        },
      };
    }
  }
  return paths;
}

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "tool_provider_project API",
    description:
      "Anox MCP tool provider — App/Action/Trigger connection broker. Gmail, Slack, SerpApi. " +
      "Action schemas below are generated live from this server's own zod definitions — what you see here " +
      "is exactly what the running server accepts and returns, not a hand-maintained approximation. " +
      "See ARCHITECTURE.md and PHASES.md in the repo root for the full flow and roadmap, and requests.http " +
      "for a side-by-side comparison against Composio's real API.",
    version: "0.2.0",
  },
  servers: [{ url: "/", description: "This server" }],
  tags: [
    { name: "users", description: "Client-facing user lifecycle." },
    { name: "connections", description: "Client-facing connection lifecycle — request, check status, and (oauth2 only) the browser-facing authorize redirect." },
    { name: "actions", description: "Invoke an App's Action against a Connection. One path per real action, schemas generated from the action's own zod definitions." },
    { name: "triggers", description: "Trigger subscription management. Not implemented yet (Phase 3) — routes exist and return 'not implemented'." },
    { name: "webhooks", description: "Inbound calls from external providers (OAuth redirect). Not authenticated with our AuthKey — see src/api/webhook_routes.ts." },
    { name: "admin", description: "Internal, read-only inspection API. No UI — API only, per spec. Not implemented yet — routes exist and return 'not implemented'." },
  ],
  paths: {
    "/users": {
      post: {
        tags: ["users"],
        summary: "Create a user",
        description: "Creates the internal identity a client acts on behalf of. `metadata` is stored opaquely, never validated or interpreted.",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  metadata: { type: "object", additionalProperties: true, description: "Opaque blob, stored as-is." },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "User created.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { user_id: { type: "string", example: "usr_..." } },
                  required: ["user_id"],
                },
              },
            },
          },
          "400": { description: "Invalid request body." },
        },
      },
    },
    "/connections": {
      post: {
        tags: ["connections"],
        summary: "Request a new connection",
        description:
          "NEVER carries secrets or a field schema, for any auth type — the request is always just " +
          "{user_id, app, extra_metadata?}, and the response is always just {connection_id, status, " +
          "connect_url?, app}. Behavior depends on the App's auth type (src/types.ts AppAuthConfig):\n" +
          "- **oauth2** (gmail, slack) and **api_key** (serpapi): both create a `pending` connection and " +
          "return the SAME shape — `connect_url`, a random Redis-backed single-use token (never the raw " +
          "connection_id). Open it in a browser: oauth2 apps redirect straight to the provider's consent " +
          "screen; api_key apps get OUR OWN server-rendered field-collection form (see GET /connect/{token} " +
          "below) — the caller never renders any UI itself.\n" +
          "- **none**: no connect step at all. Connection is `active` immediately.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  user_id: { type: "string" },
                  app: { type: "string", example: "gmail", enum: ["gmail", "slack", "serpapi"] },
                  extra_metadata: { type: "object", additionalProperties: true, description: "Opaque, like User.user_metadata — never secrets." },
                },
                required: ["user_id", "app"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Connection created — `pending` (oauth2, api_key) or `active` (none).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    connection_id: { type: "string" },
                    status: { $ref: "#/components/schemas/ConnectionStatus" },
                    connect_url: { type: "string", format: "uri", description: "oauth2 and api_key only — same shape for both." },
                    app: { type: "string" },
                  },
                  required: ["connection_id", "status", "app"],
                },
              },
            },
          },
          "400": { description: "Invalid body." },
          "501": { description: "App's auth type has no connect flow implemented (currently: \"custom\")." },
        },
      },
    },
    "/connections/{id}": {
      get: {
        tags: ["connections"],
        summary: "Get connection status",
        description: "Secrets are always redacted from this response, regardless of auth type.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" }, description: "connection_id" },
        ],
        responses: {
          "200": {
            description: "Connection record, secrets omitted.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Connection" } } },
          },
          "404": { description: "No connection with that id." },
        },
      },
    },
    "/connect/{token}": {
      get: {
        tags: ["connections"],
        summary: "The one browser-facing connect page — handles both oauth2 and api_key",
        description:
          "Public, not authenticated with our AuthKey (an end user's browser opens this directly). `token` " +
          "is single-use and Redis-backed (src/lib/redis.ts), resolved to a connection_id server-side — the " +
          "raw connection_id never appears in this URL. oauth2 apps: 302 redirect to the provider's real " +
          "consent screen. api_key apps: renders our own plain-HTML field-collection form (see " +
          "src/api/connection_routes.ts's fieldFormPage()).",
        parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The field-collection form (api_key), or an HTML error page for an expired/used token, unknown connection, or already-completed connection — both are 200 (a browser page, not an API error)." },
          "302": { description: "oauth2: redirect to the provider's consent screen." },
        },
      },
      post: {
        tags: ["connections"],
        summary: "Submit the field-collection form (api_key/custom only)",
        description:
          "Standard HTML form POST (application/x-www-form-urlencoded), not JSON — the browser submits " +
          "this itself, no JS involved. Validates required fields, then calls the App's real " +
          "testConnection() BEFORE marking the connection active. On failure, re-renders the same form with " +
          "the real provider error (token stays valid — the user can just retry). On success, the token is " +
          "deleted (single-use) and an HTML success page is shown.",
        parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: { type: "object", additionalProperties: { type: "string" }, example: { api_key: "..." } },
            },
          },
        },
        responses: {
          "200": { description: "HTML success or re-rendered-form-with-error page (see description)." },
        },
      },
    },
    ...actionPaths(),
    "/triggers/{app}/{trigger}/subscribe": {
      post: {
        tags: ["triggers"],
        summary: "Subscribe to a Trigger — NOT IMPLEMENTED (Phase 3)",
        description: "Creates a TriggerInstance for `connection_id`, picked up by the scheduler once one exists (Phase 3). Currently throws 'not implemented'.",
        parameters: [
          { name: "app", in: "path", required: true, schema: { type: "string" }, example: "gmail" },
          { name: "trigger", in: "path", required: true, schema: { type: "string" }, example: "new_email" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { connection_id: { type: "string" } },
                required: ["connection_id"],
                additionalProperties: true,
                description: "Plus delivery config, shape TBD (Phase 6).",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Trigger instance created.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/TriggerInstance" } } },
          },
          "500": { description: "Not implemented yet." },
        },
      },
    },
    "/oauth/callback/{app}": {
      get: {
        tags: ["webhooks"],
        summary: "OAuth redirect target",
        description: "The end user's browser lands here after approving the provider's consent screen. Not called by our own client — reached via /connections/{id}/authorize's redirect.",
        parameters: [
          { name: "app", in: "path", required: true, schema: { type: "string" } },
          { name: "code", in: "query", required: true, schema: { type: "string" } },
          { name: "state", in: "query", required: true, schema: { type: "string" }, description: "connection_id" },
        ],
        responses: {
          "200": { description: "Plain HTML success/failure page (see src/api/webhook_routes.ts's resultPage())." },
        },
      },
    },
    "/admin/users": {
      get: {
        tags: ["admin"],
        summary: "List users and their connections — NOT IMPLEMENTED",
        description: "Read-only. Returns connection_id/app/status only — no secrets, no user_metadata dump. No pagination in Phase 1. Currently throws 'not implemented'.",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      user_id: { type: "string" },
                      connections: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            connection_id: { type: "string" },
                            app: { type: "string" },
                            status: { $ref: "#/components/schemas/ConnectionStatus" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "500": { description: "Not implemented yet." },
        },
      },
    },
    "/admin/triggers": {
      get: {
        tags: ["admin"],
        summary: "List active trigger instances — NOT IMPLEMENTED",
        description: "Read-only. Empty array once Phase 3 lands. Currently throws 'not implemented'.",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/TriggerInstance" } } } },
          },
          "500": { description: "Not implemented yet." },
        },
      },
    },
    "/admin/logs": {
      get: {
        tags: ["admin"],
        summary: "List recent action call logs — NOT IMPLEMENTED",
        description: "Read-only. The action dispatcher already appends real entries on every call — this route to read them back just isn't wired yet. Currently throws 'not implemented'.",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50 } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/ActionLogEntry" } } } },
          },
          "500": { description: "Not implemented yet." },
        },
      },
    },
  },
  components: {
    schemas: {
      ConnectionStatus: { type: "string", enum: ["pending", "active", "revoked", "error"] },
      Connection: {
        type: "object",
        properties: {
          connection_id: { type: "string" },
          user_id: { type: "string" },
          app: { type: "string" },
          status: { $ref: "#/components/schemas/ConnectionStatus" },
          extra_metadata: { type: "object", additionalProperties: true },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
        description: "`secrets` is intentionally never included in any API response.",
      },
      TriggerInstance: {
        type: "object",
        properties: {
          trigger_instance_id: { type: "string" },
          connection_id: { type: "string" },
          user_id: { type: "string" },
          app: { type: "string" },
          trigger_key: { type: "string" },
          status: { type: "string", enum: ["active", "paused", "error"] },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      ActionLogEntry: {
        type: "object",
        properties: {
          log_id: { type: "string" },
          connection_id: { type: "string" },
          user_id: { type: "string" },
          app: { type: "string" },
          action_key: { type: "string" },
          status: { type: "string", enum: ["success", "error"] },
          called_at: { type: "string", format: "date-time" },
          duration_ms: { type: "number" },
          error: { type: "string" },
        },
      },
    },
  },
};

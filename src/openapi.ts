// OpenAPI 3.0 spec for the tool_provider API. Hand-written for the routes that don't change often
// (users/connections/admin/actions), except the `tool_slug` enum below (and each entry's one-line
// description) which is GENERATED from the real registry so it can't drift out of sync with the actual
// actions in code.
//
// Action routes are Composio-standard shape, NOT one hand-shaped OpenAPI path per action: a hand-shaped
// path per action (`/actions/gmail/list_recent_emails`, `/actions/slack/post_message`, ...) means every
// new action grows /openapi.json by a whole path object — real bloat, and it's not how Composio/Pipedream
// actually document their own tool-execute surface (confirmed against .idea/composio.http's real v3 API:
// ONE `POST /tools/execute/{tool_slug}` path, `tool_slug` a flat identifier like `SLACK_FIND_CHANNELS` —
// not two path segments). This file mirrors that: one execute path, one list path, one per-tool-schema
// path — see src/api/action_routes.ts for the route handlers. Per-action input/output schemas are still
// generated live from each ActionDefinition's real zod schema (z.toJSONSchema(), zod v4+, no extra
// dependency), just served on demand via `GET /actions/{tool_slug}` instead of inlined into every path.
//
// See requests.http for a Composio-API-reference comparison of what's implemented, missing, and extra
// relative to Composio's real v3 API (fetched from https://backend.composio.dev/api/v3/openapi.json).

import { z } from "zod";
import { listApps, toolSlug } from "./core/registry";
import type { ActionDefinition } from "./types";

function allTools() {
  return listApps().flatMap((app) =>
    (app.actions as ActionDefinition[]).map((action) => ({
      tool_slug: toolSlug(app.id, action.key),
      app: app.id,
      action: action.key,
      description: action.description,
    })),
  );
}

function actionPaths() {
  const tools = allTools();
  const toolSlugSchema = { type: "string", enum: tools.map((t) => t.tool_slug), description: "One flat identifier per action — see GET /actions for the current full list with descriptions." };

  return {
    "/actions": {
      get: {
        tags: ["actions"],
        summary: "List/search available tools",
        description: "~ Composio's `GET /tools`. Returns every real action currently in the registry — cannot list a tool that doesn't exist in code. Optional `?q=` filters by a case-insensitive word match against `tool_slug` + description.",
        parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" }, description: "Free-text filter, e.g. \"gmail\" or \"send email\"." }],
        responses: {
          "200": {
            description: "Matching tools (all of them if `q` is omitted or matches nothing).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tools: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          tool_slug: toolSlugSchema,
                          app: { type: "string" },
                          action: { type: "string" },
                          description: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/actions/{tool_slug}": {
      get: {
        tags: ["actions"],
        summary: "Get one tool's real input/output schema",
        description: "~ Composio's `GET /tools/{slug}`. `input_schema`/`output_schema` are this action's actual zod schemas (z.toJSONSchema()) — call this on demand for the one tool_slug you're about to execute, instead of every action's schema being pre-inlined into every path.",
        parameters: [{ name: "tool_slug", in: "path", required: true, schema: toolSlugSchema }],
        responses: {
          "200": {
            description: "Tool schema.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tool_slug: toolSlugSchema,
                    app: { type: "string" },
                    action: { type: "string" },
                    description: { type: "string" },
                    input_schema: { type: "object", description: "This action's real zod input schema, as JSON Schema." },
                    output_schema: { type: "object", description: "This action's real zod output schema, as JSON Schema." },
                  },
                },
              },
            },
          },
          "404": { description: "Unknown tool_slug." },
        },
      },
    },
    "/actions/execute/{tool_slug}": {
      post: {
        tags: ["actions"],
        summary: "Execute a tool",
        description: "~ Composio's `POST /tools/execute/{tool_slug}`. `input` is validated against the real action's zod schema (fetch it first via `GET /actions/{tool_slug}`) before it runs, and the result is validated against its output schema before it's returned.",
        parameters: [{ name: "tool_slug", in: "path", required: true, schema: toolSlugSchema }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  connection_id: { type: "string", description: "Must be an active connection to this tool_slug's app." },
                  input: { type: "object", description: "This action's own input — shape varies per tool_slug, see GET /actions/{tool_slug}." },
                },
                required: ["connection_id", "input"],
              },
            },
          },
        },
        responses: {
          "200": { description: "Action result, matching this action's real output schema (GET /actions/{tool_slug})." },
          "400": { description: "Input failed this action's schema." },
          "404": { description: "Unknown tool_slug, or unknown connection_id." },
          "409": { description: "Connection exists but isn't active yet." },
          "500": { description: "The action ran but the underlying API call failed (message includes the provider's real error)." },
        },
      },
    },
  };
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
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "users", description: "Client-facing user lifecycle." },
    { name: "connections", description: "Client-facing connection lifecycle — request, check status, and (oauth2 only) the browser-facing authorize redirect." },
    { name: "actions", description: "Discover and invoke tools (App Actions) by tool_slug — Composio-shaped: GET /actions (list/search), GET /actions/{tool_slug} (schema), POST /actions/execute/{tool_slug} (run). One generic path per verb, not one path per action." },
    { name: "triggers", description: "Discover trigger types, subscribe/unsubscribe, and list/edit a user's own trigger instances." },
    { name: "webhooks", description: "Inbound calls from external providers (OAuth redirect). Not gated by our bearer token — see src/api/webhook_routes.ts." },
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
      get: {
        tags: ["connections"],
        summary: "List a user's connections (~ Composio's GET /connected_accounts, filtered to one user)",
        description: "Client-facing 'what have I connected' — required `user_id`, optional `app` to narrow to one app. Secrets always redacted, same as GET /connections/{id}.",
        parameters: [
          { name: "user_id", in: "query", required: true, schema: { type: "string" } },
          { name: "app", in: "query", required: false, schema: { type: "string" }, example: "gmail" },
        ],
        responses: {
          "200": {
            description: "This user's connections (all apps, or just `app` if given).",
            content: { "application/json": { schema: { type: "object", properties: { connections: { type: "array", items: { $ref: "#/components/schemas/Connection" } } } } } },
          },
          "400": { description: "Missing user_id." },
        },
      },
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
          "Public, NOT gated by our bearer token (an end user's browser opens this directly and can't " +
          "attach an Authorization header). `token` is single-use and Redis-backed (src/lib/redis.ts), " +
          "resolved to a connection_id server-side — the raw connection_id never appears in this URL, and " +
          "that single-use token IS this route's real auth boundary. oauth2 apps: 302 redirect to the " +
          "provider's real consent screen. api_key apps: renders our own plain-HTML field-collection form " +
          "(see src/api/connection_routes.ts's fieldFormPage()).",
        security: [],
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
          "this itself, no JS involved. Public, NOT gated by our bearer token — same reasoning as GET " +
          "above. Validates required fields, then calls the App's real " +
          "testConnection() BEFORE marking the connection active. On failure, re-renders the same form with " +
          "the real provider error (token stays valid — the user can just retry). On success, the token is " +
          "deleted (single-use) and an HTML success page is shown.",
        security: [],
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
    "/triggers": {
      get: {
        tags: ["triggers"],
        summary: "List available trigger TYPES (~ Composio's GET /triggers_types)",
        description: "Every real trigger currently in the registry — generated live, same discipline as GET /actions. Distinct from GET /triggers/instances below: this lists what CAN be subscribed to, not what a user already has subscribed.",
        responses: {
          "200": {
            description: "Trigger types.",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/TriggerType" } } } },
          },
        },
      },
    },
    "/triggers/instances": {
      get: {
        tags: ["triggers"],
        summary: "List a user's subscribed trigger instances",
        description: "Client-facing 'which triggers have I actually subscribed to' — required `user_id`, optional `app` to narrow.",
        parameters: [
          { name: "user_id", in: "query", required: true, schema: { type: "string" } },
          { name: "app", in: "query", required: false, schema: { type: "string" }, example: "gmail" },
        ],
        responses: {
          "200": {
            description: "This user's trigger instances.",
            content: { "application/json": { schema: { type: "object", properties: { trigger_instances: { type: "array", items: { $ref: "#/components/schemas/TriggerInstance" } } } } } },
          },
          "400": { description: "Missing user_id." },
        },
      },
    },
    "/triggers/instances/{id}/logs": {
      get: {
        tags: ["triggers"],
        summary: "What a trigger instance has actually fired (~ Stripe CLI's `events list`)",
        description: "Every poll attempt and webhook delivery attempt for one instance, newest first — status, which webhook_url each attempt went to, the error if any, and `resendable` (whether POST /triggers/logs/{log_id}/resend will work on it). `user_id` required and checked against the instance's own owner.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" }, description: "trigger_instance_id" },
          { name: "user_id", in: "query", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50 } },
        ],
        responses: {
          "200": {
            description: "The instance's current status/webhook_url, plus its run history.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    trigger_instance: { type: "object", properties: { trigger_instance_id: { type: "string" }, status: { type: "string" }, webhook_url: { type: "string" } } },
                    logs: { type: "array", items: { $ref: "#/components/schemas/TriggerLogEntry" } },
                  },
                },
              },
            },
          },
          "400": { description: "Missing user_id." },
          "404": { description: "Unknown trigger instance, or it doesn't belong to user_id." },
        },
      },
    },
    "/triggers/logs/{log_id}": {
      get: {
        tags: ["triggers"],
        summary: "Get one trigger event's full body (~ Stripe's `GET /v1/events/{id}`)",
        description: "`log_id` IS the event id for a delivery row (`evt_...` — src/core/scheduler.ts's deliverEvent/resendDelivery generate one id, used as both the envelope's own `id` and this row's `log_id`). Returns the full row including `payload` — the actual delivered body — which GET /triggers/instances/{id}/logs deliberately omits. `user_id` required and checked against the log's own owner.",
        parameters: [
          { name: "log_id", in: "path", required: true, schema: { type: "string" } },
          { name: "user_id", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "The full log row, including its payload.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/TriggerLogEntry" } } },
          },
          "400": { description: "Missing user_id." },
          "404": { description: "Unknown trigger log, or it doesn't belong to user_id." },
        },
      },
    },
    "/triggers/logs/{log_id}/resend": {
      post: {
        tags: ["triggers"],
        summary: "Resend a trigger delivery (~ Stripe CLI's `events resend`)",
        description: "Re-POSTs an already-captured delivery's exact payload (same event id/timestamp — a resend, not a new event) to the trigger instance's CURRENT webhook_url, which may differ from the one the log row originally recorded if it's since been updated. Only works on a `resendable` log (one with a captured payload — webhook-delivery rows, not poll-attempt rows). Writes its own new trigger_logs row, itself resendable.",
        parameters: [{ name: "log_id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { user_id: { type: "string", description: "Must match the log's own owner." } }, required: ["user_id"] },
            },
          },
        },
        responses: {
          "201": {
            description: "The NEW log row created by this resend attempt (not the original).",
            content: { "application/json": { schema: { type: "object", properties: { log_id: { type: "string" }, status: { type: "string" }, ran_at: { type: "string" }, webhook_url: { type: "string" }, error: { type: "string" } } } } },
          },
          "400": { description: "Invalid body, or the log has no captured payload to resend." },
          "404": { description: "Unknown trigger log, or it doesn't belong to user_id." },
        },
      },
    },
    "/triggers/{app}/{trigger}/subscribe": {
      post: {
        tags: ["triggers"],
        summary: "Subscribe to a Trigger",
        description: "Creates a TriggerInstance for `connection_id`, picked up by the scheduler (poll-mode) or the matching webhook route (webhook-mode, e.g. Slack) once it exists.",
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
                properties: {
                  connection_id: { type: "string", description: "Must be an active connection to this `app`." },
                  webhook_url: { type: "string", format: "uri", description: "Where we POST each event once this trigger fires." },
                  poll_interval_ms: { type: "integer", description: "Override the trigger's own default. Poll-mode only; ignored for webhook-mode triggers." },
                  extra_metadata: { type: "object", additionalProperties: true, description: "Opaque client space, e.g. { notes: '...' } — never read/interpreted by us, editable later via PATCH /triggers/{id}. Capped at 4096 bytes of JSON (see src/api/trigger_routes.ts's MAX_EXTRA_METADATA_BYTES)." },
                },
                required: ["connection_id", "webhook_url"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Trigger instance created.",
            content: { "application/json": { schema: { type: "object", properties: { trigger_instance_id: { type: "string" }, status: { type: "string" }, poll_interval_ms: { type: "integer", nullable: true } } } } },
          },
          "400": { description: "Invalid body, or extra_metadata over the size cap." },
          "404": { description: "Unknown app/trigger, or unknown connection_id." },
          "409": { description: "Connection exists but isn't active yet." },
        },
      },
    },
    "/triggers/{id}": {
      delete: {
        tags: ["triggers"],
        summary: "Unsubscribe (delete a trigger instance)",
        description: "Real delete, not a soft-disable — no pause/resume yet (delete + re-subscribe is the only option, see PHASES.md Phase 3's open item). Its trigger_logs history is deleted with it (cascade).",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "trigger_instance_id" }],
        responses: {
          "200": { description: "Deleted." },
          "404": { description: "Unknown trigger instance." },
        },
      },
      patch: {
        tags: ["triggers"],
        summary: "Update a trigger instance's extra_metadata",
        description: "Metadata-only update — the client's own notes/tags space, editable after subscribe time (unlike Connection.extra_metadata, which is write-once). Everything else about the instance (webhook_url, poll_interval_ms, ...) is immutable post-subscribe: delete + re-subscribe is the only way to change those.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "trigger_instance_id" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { extra_metadata: { type: "object", additionalProperties: true } }, required: ["extra_metadata"] },
            },
          },
        },
        responses: {
          "200": { description: "Updated." },
          "400": { description: "Invalid body, or extra_metadata over the size cap." },
          "404": { description: "Unknown trigger instance." },
        },
      },
    },
    "/oauth/callback/{app}": {
      get: {
        tags: ["webhooks"],
        summary: "OAuth redirect target",
        description: "The end user's browser lands here after approving the provider's consent screen. Not called by our own client — reached via /connections/{id}/authorize's redirect. Public, NOT gated by our bearer token, same reasoning as /connect/{token}.",
        security: [],
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
    securitySchemes: {
      // Matches src/lib/apiAuth.ts exactly: `Authorization: Bearer <ACCESS_TOKEN or ADMIN_ACCESS_TOKEN>`.
      // Click "Authorize" above and paste one in — /admin/* routes require ADMIN_ACCESS_TOKEN specifically,
      // every other gated route accepts either. /connect/{token}, /oauth/callback/{app}, and
      // /webhooks/slack/events are intentionally NOT covered by this (see their own route file comments).
      bearerAuth: { type: "http", scheme: "bearer", description: "Internal-only access token — see .env.example's ACCESS_TOKEN / ADMIN_ACCESS_TOKEN." },
    },
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
          webhook_url: { type: "string", format: "uri" },
          poll_interval_ms: { type: "integer", nullable: true },
          extra_metadata: { type: "object", additionalProperties: true, description: "Opaque client space — see PATCH /triggers/{id}." },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      TriggerType: {
        type: "object",
        description: "An available trigger DEFINITION (what CAN be subscribed to), not a TriggerInstance (what IS subscribed) — see GET /triggers vs GET /triggers/instances.",
        properties: {
          app: { type: "string" },
          key: { type: "string" },
          description: { type: "string" },
          mode: { type: "string", enum: ["poll", "webhook"] },
          default_poll_interval_ms: { type: "integer", nullable: true },
          payload: { type: "object", nullable: true, description: "JSON Schema of the `data` object delivered to webhook_url, or null if not yet declared." },
        },
      },
      TriggerLogEntry: {
        type: "object",
        description: "One row per trigger RUN — a poll attempt or a webhook delivery attempt. Only delivery attempts carry `webhook_url`/`payload` (poll attempts have neither) — that's what makes a row resendable, see POST /triggers/logs/{log_id}/resend.",
        properties: {
          log_id: { type: "string" },
          trigger_instance_id: { type: "string" },
          app: { type: "string" },
          trigger_key: { type: "string" },
          status: { type: "string", enum: ["success", "error"] },
          ran_at: { type: "string", format: "date-time" },
          error: { type: "string" },
          webhook_url: { type: "string", format: "uri", description: "The URL this attempt was actually sent to (delivery rows only)." },
          payload: { type: "object", description: "The exact envelope POSTed — {id, type, metadata, data, timestamp} (delivery rows only)." },
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

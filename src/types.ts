// Core contract types. Every App (gmail, slack, ...) is written against this shape.
// See ../../ARCHITECTURE.md for the terminology + flow this maps to.

import type { z } from "zod";

export type AppId = string; // e.g. "gmail", "slack"

// uuid v4 (crypto.randomUUID()), prefixed per entity — Composio/Stripe-style: "conn_...", "usr_...", "ti_...".
export type UserId = string;
export type ConnectionId = string;

export interface User {
  user_id: UserId;
  // Opaque blob the client passed at creation time. We never read/validate its shape — "nothing fancy" per spec.
  user_metadata: Record<string, unknown>;
  created_at: string;
}

export type ConnectionStatus = "pending" | "active" | "revoked" | "error";

export interface Connection {
  connection_id: ConnectionId;
  user_id: UserId;
  app: AppId;
  status: ConnectionStatus;
  // Generic secret bag, not OAuth-specific — oauth2 apps store { access_token, refresh_token?, expires_at?,
  // scope? }, api_key apps store { api_key } (per SerpApi: the caller supplies this directly at connect
  // time, there's no redirect/callback for it — see connection_routes.ts). Encrypted at rest by
  // src/core/store.ts (src/lib/cipher.ts) — every call site here only ever sees it decrypted; the store is
  // the one place that knows encryption exists at all.
  secrets: Secrets | null;
  // Opaque, like User.user_metadata — passed at POST /connections time (never secrets, never anything
  // needed to actually run an action), stored and returned as-is. Never redacted from responses, unlike secrets.
  extra_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Deliberately a loose Record, not a fixed oauth2-shaped interface — different auth types need different
// fields, and locking this to { access_token, refresh_token, ... } is exactly what made api_key apps not
// fit before. `expires_at` is the one field every reader can rely on being absent for non-expiring secrets
// (api_key) rather than present-but-meaningless.
export type Secrets = Record<string, string | undefined> & { expires_at?: string };

// Declares one field a UI needs to collect from the end user for an api_key/custom connection — this is
// the schema POST /connections returns instead of a connect_url, so a UI can render a form dynamically
// (matches Composio's auth_config_details.fields.auth_config_creation shape, seen in
// /home/gr/projects/backend's integration_routes.py generate_connection_url()). `name` is the key it lands
// under in Connection.secrets once submitted.
export interface AuthField {
  name: string; // e.g. "api_key" — the Secrets key this fills in
  label: string; // human-readable, for the UI to render as a form field label
  required: boolean;
  secret: boolean; // true = mask in the UI (password-style input), and never echo back once set
}

// One declarative auth config per App. Discriminated on `type` — oauth2 apps (Gmail, Slack) carry the full
// client/authorize/token shape; api_key apps (SerpApi) carry nothing at the App level at all, since there's
// no platform-managed app registration for a key the end user supplies per-connection.
export type AppAuthConfig =
  | {
      type: "oauth2";
      authorize_url: string;
      token_url: string;
      scopes: string[];
      // Resolved from process.env at App-registration time — see src/components/<app>/app.ts for the exact env var names.
      client_id: string;
      client_secret: string;
      // Provider-specific extra query params for the authorize step. Google needs `access_type=offline` +
      // `prompt=consent` to actually get a refresh_token back (without these it silently omits one on repeat
      // authorizations) — Slack doesn't need this, so it's per-app, not baked into buildAuthorizeUrl itself.
      extraAuthorizeParams?: Record<string, string>;
    }
  | {
      type: "api_key";
      // The field(s) a UI must collect before this connection can go active — POST /connections for an
      // api_key app returns this array instead of a connect_url; the caller collects values on the fly
      // and submits them to POST /connections/:id/secrets (see connection_routes.ts), which validates
      // them (AppDefinition.testConnection, if declared) before marking the connection active.
      fields: AuthField[];
    }
  | {
      // No credential of any kind — the app's actions call a public/unauthenticated API. No popup, no
      // redirect, no secret to collect: POST /connections for a "none" app creates an active connection
      // immediately (same as api_key's immediate-active path, minus needing any input at all). Matches
      // Composio's NO_AUTH concept, per /home/gr/projects/backend/.../integration_routes.py.
      type: "none";
    }
  | {
      // TODO(ask): jwt | hmac_signature | custom, per auth-patterns.md #2 — not real code yet, no app needs
      // it. Listed here so the union's shape is the actual decision point, not a comment promising it later.
      // Would carry `fields: AuthField[]` too, same as api_key, once a real app needs it.
      type: "custom";
    };

export interface ActionDefinition<Input = unknown, Output = unknown> {
  key: string; // e.g. "send_email"
  description: string;
  // Declared props — this is what makes an action introspectable (an MCP tool schema, an admin/debug
  // view, or just a caller checking what an action expects) instead of only "call it and find out".
  // z.infer<typeof input> must match Input, same for output — action_routes.ts validates both directions:
  // input at the request boundary (400 on bad input), output as a cheap correctness check on run()'s result.
  input: z.ZodType<Input>;
  output: z.ZodType<Output>;
  run: (connection: Connection, input: Input) => Promise<Output>;
}

export type TriggerMode = "poll" | "webhook";

export interface TriggerDefinition<Cursor = unknown, Event = unknown> {
  key: string; // e.g. "new_email"
  description: string;
  mode: TriggerMode;
  // Only relevant when mode === "poll" — the trigger's OWN natural cadence, not a single global setting
  // applied to everything. Per Pipedream's actual `timer: { type: "$.interface.timer", default: {
  // intervalSeconds: DEFAULT_POLLING_SOURCE_TIMER_INTERVAL } }` prop pattern (verified from their real
  // published npm package, @pipedream/platform's constants.ts: `DEFAULT_POLLING_SOURCE_TIMER_INTERVAL =
  // 60 * 15` — 15 minutes) and Composio's per-trigger `trigger_config.interval` (their docs: a 15-minute
  // *minimum* as of their 2026-03-11 changelog). Two real platforms independently landing on 15 minutes is
  // a strong signal — that's this project's default too (see each trigger's own file), overridable per
  // TriggerInstance at subscribe time (src/api/trigger_routes.ts), same as both platforms allow.
  defaultPollIntervalMs?: number;
  // Only relevant when mode === "poll". Returns new events + the next cursor to persist.
  poll?: (connection: Connection, cursor: Cursor | null) => Promise<{ events: Event[]; nextCursor: Cursor }>;
  // Only relevant when mode === "webhook". Parses a raw inbound payload into normalized events.
  handleWebhook?: (connection: Connection, rawPayload: unknown) => Promise<Event[]>;
}

export interface AppDefinition {
  id: AppId;
  name: string;
  auth: AppAuthConfig;
  // Only meaningful for api_key/custom auth (see connection_routes.ts's POST /connections/:id/secrets) —
  // makes a cheap real call to confirm the submitted secrets actually work BEFORE marking the connection
  // active, instead of finding out on the first real action call. Throw with a real, provider-surfaced
  // message on failure (per the pattern every action.run() already follows); resolve on success.
  // oauth2 apps don't need this — a successful token exchange already proves the credential works.
  testConnection?: (secrets: Secrets) => Promise<void>;
  // `any` here, not `unknown` — a heterogeneous array of e.g. ActionDefinition<SendEmailInput, ...> and
  // ActionDefinition<ListRecentEmailsInput, ...> has no single sound element type; `unknown` generics make
  // TS reject assigning any concretely-typed action/trigger into this array (contravariant param position).
  // The registry only ever iterates/looks-up by key, never calls .run()/.poll() generically, so `any` here
  // costs nothing real — each components/*/actions/*.ts file still keeps its own real Input/Output types.
  actions: ActionDefinition<any, any>[];
  triggers: TriggerDefinition<any, any>[];
}

// --- Admin-facing records (Phase 3+, but declared now since /admin reads them) ---

export type TriggerInstanceStatus = "active" | "paused" | "error";

export interface TriggerInstance {
  trigger_instance_id: string;
  connection_id: ConnectionId;
  user_id: UserId;
  app: AppId;
  trigger_key: string;
  status: TriggerInstanceStatus;
  // Where the scheduler POSTs events when this trigger fires — "we will call the user webhook_url when
  // we receive any trigger", same fan-in-per-subscription idea as Composio's set_webhook_subscription,
  // just attached directly to the trigger instance rather than as a separate project-wide resource (see
  // research/triggers-patterns.md's "Trigger setup vs. trigger delivery" section for why that's a
  // deliberate simplification, not an oversight, at our current scale).
  webhook_url: string;
  // Resolved once at subscribe time — the trigger's own defaultPollIntervalMs, or an explicit override
  // from the subscribe request (src/api/trigger_routes.ts). Only meaningful for mode: "poll" triggers;
  // webhook-mode triggers (Slack) never poll at all, so this is unused for them. src/core/scheduler.ts
  // uses this per-instance, not one interval applied to every trigger — see TriggerDefinition's comment.
  poll_interval_ms: number | null;
  // Per-app-shaped (GmailHistoryCursor vs a label-id set vs SlackPollCursor) — opaque here on purpose,
  // src/core/scheduler.ts passes it straight through to the trigger's own poll() untouched.
  cursor: unknown;
  created_at: string;
  updated_at: string;
}

export type ActionCallStatus = "success" | "error";

export interface ActionLogEntry {
  log_id: string;
  connection_id: ConnectionId;
  user_id: UserId;
  app: AppId;
  action_key: string;
  status: ActionCallStatus;
  called_at: string;
  duration_ms?: number;
  // TODO(ask): store the actual error message/stack for admin debugging, or just the status per your
  // "nothing else" scoping for /admin/users — same question applies here: how much detail is "admin", not
  // "full observability tool"?
  error?: string;
}

export type TriggerLogStatus = "success" | "error";

// One row per trigger RUN — a poll attempt (whether or not it produced events) or a single webhook
// delivery attempt (src/core/scheduler.ts's deliverEvent, called by both the poll cycle and Slack's
// webhook route). Deliberately no retry: per spec ("no need to retry at all, just failed ok") a failed
// delivery/poll is recorded here as status "error" and left alone — this table is the audit trail, not a
// retry queue.
export interface TriggerLogEntry {
  log_id: string;
  trigger_instance_id: string;
  connection_id: ConnectionId;
  user_id: UserId;
  app: AppId;
  trigger_key: string;
  status: TriggerLogStatus;
  ran_at: string;
  error?: string;
}

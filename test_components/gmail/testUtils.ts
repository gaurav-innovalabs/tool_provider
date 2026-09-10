// Shared test scaffolding for every test_components/gmail/**/*.test.ts file, testing the real
// src/components/gmail/actions/*.ts and triggers/*.ts code. Mirrors test_components/slack/testUtils.ts's
// shape (mock `fetch`, one Connection fixture, reuse the action/trigger's own declared zod schemas) —
// duplicated rather than shared, same "no common/ folder until a second consumer actually needs it"
// reasoning as src/components/TODO.md's own open decision about component code.

import { mock } from "bun:test";
import type { z } from "zod";
import type { ActionDefinition, Connection, Secrets, TriggerDefinition } from "../../src/types";

export function makeGmailConnection(secrets: Secrets = { access_token: "ya29.test-access-token" }): Connection {
  return {
    connection_id: "conn_test",
    user_id: "usr_test",
    app: "gmail",
    status: "active",
    secrets,
    extra_metadata: {},
    expires_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

interface MockFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown; // parsed JSON body, or undefined for GET/DELETE with no body
}

// Installs a `global.fetch` mock that serves `responses` in call order — one entry per expected HTTP call.
// Gmail's REST API is plain fetch (no SDK, per sendEmail.ts's header comment), so every action/trigger call
// site is just an ordinary `fetch(url, init)` — this can stay a simple queue, no method-specific quirks
// like Slack's form-encoding/ok:false-on-200 to route around.
export function mockGmailFetch(responses: { status?: number; body: unknown }[]): { calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = [];
  let callIndex = 0;

  const fetchMock = mock(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = init?.body;

    let parsedBody: unknown = rawBody;
    if (typeof rawBody === "string") {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }

    calls.push({ url, method, headers, body: parsedBody });

    const response = responses[callIndex];
    callIndex += 1;
    if (!response) {
      throw new Error(`mockGmailFetch: no mocked response queued for call #${callIndex} (${method} ${url})`);
    }

    if (response.status === 204) {
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });

  // @ts-expect-error — bun's fetch type is stricter than the minimal mock signature above needs to be
  global.fetch = fetchMock;
  return { calls };
}

// Runs an action end-to-end against its OWN declared zod schemas — same idea as slack/testUtils.ts's
// runAction: parses `params` through `action.input` before calling run(), and the result through
// `action.output` before returning it, so a schema change can't silently drift out of sync with a test's
// hand-maintained expectations.
export async function runAction<Input, Output>(
  action: ActionDefinition<Input, Output>,
  connection: Connection,
  rawParams: unknown,
): Promise<Output> {
  const params = action.input.parse(rawParams) as Input;
  const result = await action.run(connection, params);
  return action.output.parse(result) as Output;
}

// Runs one poll() call, validating each returned event against the trigger's own declared `payload`
// schema when it has one (some triggers haven't tightened payload yet — see types.ts's comment on why
// that's optional).
export async function runPoll<Cursor, Event>(
  trigger: TriggerDefinition<Cursor, Event>,
  connection: Connection,
  cursor: Cursor | null,
): Promise<{ events: Event[]; nextCursor: Cursor }> {
  if (!trigger.poll) {
    throw new Error(`runPoll: trigger "${trigger.key}" has no poll() (mode: ${trigger.mode})`);
  }
  const result = await trigger.poll(connection, cursor);
  if (trigger.payload) {
    for (const event of result.events) trigger.payload.parse(event);
  }
  return result;
}

export function expectValidOutput<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

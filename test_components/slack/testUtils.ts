// Shared test scaffolding for every test_components/slack/actions/*.test.ts file, testing the real
// src/components/slack/actions/*.ts action code (tests live in this separate test_components/ tree,
// mirroring src/components/ 1:1, rather than colocated *.test.ts next to the source). Centralized so all
// action tests mock `fetch` the same way and share one Connection fixture shape — a per-file mock harness
// is how this kind of drift starts (one test checks status, another checks .ok, a third forgets the
// Slack-returns-200-on-error quirk entirely). Keeping this in one place is what makes the suite scale as
// more actions/apps get added, not just what makes today's 15 files shorter.
//
// Pattern borrowed from how Pipedream/Composio's own component test fixtures work: mock the wire response
// exactly as the provider's real API reference documents it (see each action file's own "API reference"
// header comment for the doc URL used), never a hand-wavy shape — so a test failure means either our code
// or our understanding of the docs is wrong, not "the mock disagreed with itself".

import { mock } from "bun:test";
import type { z } from "zod";
import type { ActionDefinition, Connection, Secrets } from "../../src/types";

export function makeSlackConnection(secrets: Secrets = { access_token: "xoxb-test-bot-token" }): Connection {
  return {
    connection_id: "conn_test",
    user_id: "usr_test",
    app: "slack",
    status: "active",
    secrets,
    extra_metadata: {},
    expires_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

// A Connection whose bot token is present but user token (secrets.user_access_token) is not — the fixture
// every as_user:true / find_messages "no user token" rejection test starts from.
export function makeBotOnlyConnection(): Connection {
  return makeSlackConnection({ access_token: "xoxb-test-bot-token" });
}

export function makeBotAndUserConnection(): Connection {
  return makeSlackConnection({ access_token: "xoxb-test-bot-token", user_access_token: "xoxp-test-user-token" });
}

interface MockFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown; // parsed JSON body, or the raw string/Buffer for non-JSON bodies (e.g. upload_file's raw bytes PUT)
}

// Installs a `global.fetch` mock that serves `responses` in call order (one entry per expected HTTP call —
// most actions make one, send_direct_message/upload_file make 2-3 chained calls). Returns the call log so
// a test can assert on the exact URL/method/body it sent, not just the parsed result — Slack's Web API has
// enough method-specific footguns (form-encoded vs JSON, `timestamp` vs `ts` field naming, etc.) that
// asserting the outbound request shape is as important as asserting the parsed response.
export function mockSlackFetch(responses: { status?: number; body: unknown }[]): { calls: MockFetchCall[] } {
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
        parsedBody = rawBody; // e.g. URLSearchParams.toString() or non-JSON text
      }
    }

    calls.push({ url, method, headers, body: parsedBody });

    const response = responses[callIndex];
    callIndex += 1;
    if (!response) {
      throw new Error(`mockSlackFetch: no mocked response queued for call #${callIndex} (${method} ${url})`);
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

// Runs an action end-to-end against its OWN declared zod schemas — parses `params` through `action.input`
// before calling run() (same validation action_routes.ts does at the real HTTP boundary) and parses the
// result through `action.output` before returning it. This is the "reuse the declarations" part: if an
// action's input/output shape changes, every test using this helper re-validates against the new shape
// automatically instead of a hand-maintained expected-object literal silently drifting out of sync.
export async function runAction<Input, Output>(
  action: ActionDefinition<Input, Output>,
  connection: Connection,
  rawParams: unknown,
): Promise<Output> {
  const params = action.input.parse(rawParams) as Input;
  const result = await action.run(connection, params);
  return action.output.parse(result) as Output;
}

// For asserting a raw provider payload matches what the action's own output schema expects — lets a test
// do `expectValidOutput(findMessages.output, result)` instead of hand-listing every field again.
export function expectValidOutput<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

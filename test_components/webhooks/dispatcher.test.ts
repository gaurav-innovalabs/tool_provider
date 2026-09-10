// The generic POST /webhooks/:app/:hook dispatcher (src/api/webhook_routes.ts) — verifies it has zero
// per-provider knowledge of its own: unknown app -> 404, known app + unknown hook -> 404, known app +
// known hook -> delegates to that app's registered handler untouched. Doesn't exercise Slack's own
// signature verification / event parsing — that's ../slack/triggers/config.test.ts (matchesConfig) plus
// manual verification against the real Events API (see tool_provider.http's url_verification example);
// this file is only about the routing layer webhook_routes.ts owns.

import { describe, test, expect } from "bun:test";
import { webhookRoutes } from "../../src/api/webhook_routes";

const dispatch = webhookRoutes["/webhooks/:app/:hook"].POST;

function req(app: string, hook: string, body: unknown = {}): Request & { params: { app: string; hook: string } } {
  const r = new Request("http://localhost/webhooks/" + app + "/" + hook, {
    method: "POST",
    body: JSON.stringify(body),
  }) as Request & { params: { app: string; hook: string } };
  r.params = { app, hook };
  return r;
}

describe("POST /webhooks/:app/:hook dispatcher", () => {
  test("404s on an unknown app", async () => {
    const res = await dispatch(req("not-a-real-app", "events"));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Unknown app");
  });

  test("404s on a known app with no handler for that hook", async () => {
    const res = await dispatch(req("slack", "not-a-real-hook"));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No webhook receiver");
  });

  test("404s for gmail (poll-only, registers no webhooks at all)", async () => {
    const res = await dispatch(req("gmail", "events"));
    expect(res.status).toBe(404);
  });

  test("delegates slack/events to the registered handler (reaches real Slack signature verification, not a 404)", async () => {
    const res = await dispatch(req("slack", "events", { type: "url_verification", challenge: "x" }));
    // No SLACK_SIGNING_SECRET in the test env -> the handler itself 500s on misconfiguration, not this
    // dispatcher — the point being verified here is that it was reached at all (not 404), proving
    // app.webhooks["events"] was found and called.
    expect(res.status).not.toBe(404);
  });
});

// Every *_routes.ts catch block used to do `err instanceof Error ? err.message : String(err)` — fine for
// a plain Error, but for a z.ZodError, `.message` is a pretty-printed JSON array of issues (zod's own
// default), e.g. `[\n  {\n    "expected": "object",\n    ...` — a real string, but useless once it lands
// inside a JSON `{ "error": "..." }` response: the literal `\n`/quote characters just render as escaped
// garbage to anyone reading the response, not a readable message. This turns that into one clean line per
// issue instead, still carrying the same information (path + what was wrong).

import { z } from "zod";

// One issue -> "at <path>: <message>", or "in the request body: <message>" for a root-level issue (path:
// []) — e.g. POST with no body at all fails validation at the root, not at a named field.
function formatIssue(issue: z.ZodError["issues"][number]): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : null;
  return path ? `at ${path}: ${issue.message}` : `in the request body: ${issue.message}`;
}

// Use in every *_routes.ts catch block instead of the raw `err.message`/`String(err)` pattern — same
// input, readable output either way.
export function formatError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map(formatIssue).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

// Bun.sql/postgres.js's own driver errors look like `Failed query: insert into "connections" (...) values
// ($1, $2, ...)\nparams: conn_xyz,usr_abc,gmail,...` — that's the RAW SQL statement plus every bound
// parameter value verbatim. It used to reach `formatError` untouched and get returned straight to the
// client on an unvalidated foreign-key violation (e.g. POST /connections with a user_id that doesn't
// exist) — a genuine info leak (schema, column names, and every param value, potentially including
// secrets-adjacent data in other queries) disguised as a generic 500, and a confusing "Failed query: ..."
// message for something that's really just "that user_id doesn't exist" and should have been a clean 404.
function looksLikeRawDatabaseError(err: unknown): boolean {
  return err instanceof Error && /^(Failed query|relation .* does not exist|duplicate key value)/i.test(err.message);
}

// The ONE place every route's catch block should build its error Response from now on — replaces the
// repeated `const status = err instanceof z.ZodError ? 400 : 500; return Response.json({ error:
// formatError(err) }, { status })` pattern that used to be copy-pasted into every *_routes.ts file
// (action/connection/trigger/user_routes.ts). Centralizing it fixes two things everywhere at once, not
// just at one call site:
//   1. Every 5xx is now unconditionally logged server-side (console.error) with the REAL underlying error
//      — previously a 500 could reach the client with nothing printed in the server's own terminal at all,
//      making it look "silently" broken even though the API did technically respond.
//   2. A raw database driver error (see looksLikeRawDatabaseError above) never reaches the client verbatim
//      — the full detail still goes to the server log (for a developer to actually debug it), but the
//      HTTP response gets a generic, safe message instead of leaked SQL/params.
// This does NOT replace explicit `if (!thing) return Response.json({error: "Unknown thing"}, {status: 404})`
// checks before a mutation — those are still the right, more specific fix for a KNOWN missing reference
// (see connection_routes.ts's user_id/app validation) and should always run first. This is the safety net
// for whatever wasn't (or can't be) checked ahead of time.
export function errorResponse(err: unknown, fallbackStatus = 500): Response {
  const status = err instanceof z.ZodError ? 400 : fallbackStatus;
  if (status >= 500) {
    console.error(`[api] ${status} error:`, err);
  }
  const message = status >= 500 && looksLikeRawDatabaseError(err) ? "Internal server error — check server logs for details." : formatError(err);
  return Response.json({ error: message }, { status });
}

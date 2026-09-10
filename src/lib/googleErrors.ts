// Google APIs (Gmail here) return a real JSON error body — { error: { code, message, status, errors: [...]
// } } — but every call site here used to just dump the ENTIRE raw response text into a thrown Error's
// message, e.g. `Gmail X failed (404): {\n  "error": {\n    "code": 404,\n    "message": "Requested entity
// was not found.",\n    ...\n  }\n}\n` — once that lands in a JSON API response (trigger_logs.error,
// action_logs.error), those literal newlines/quotes render as unreadable escaped garbage instead of the
// one useful line inside it. This pulls out just `.error.message` (+ `.error.status` for context, e.g.
// "NOT_FOUND") when the body parses as Google's real error shape, falling back to the raw text untouched
// for anything else (a non-JSON body, a body with no `.error.message`) — never silently swallowing
// information, just not drowning the one useful sentence in the rest of the envelope.
export async function describeGoogleApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) {
      return parsed.error.status ? `${parsed.error.message} (${parsed.error.status})` : parsed.error.message;
    }
  } catch {
    // Not JSON, or JSON without the expected .error.message shape — fall through to the raw text below.
  }
  return text;
}

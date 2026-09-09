// SerpApi App definition — first api_key-type app (Gmail/Slack are both oauth2). No client_id/secret, no
// authorize/token URLs: there's no platform-managed app registration for this kind of auth.
//
// Flow: POST /connections { user_id, app: "serpapi" } (no secrets — see connection_routes.ts) returns
// `auth.fields` below so a UI can render a form. Caller submits the collected value(s) to
// POST /connections/:id/secrets, which calls testConnection() below to confirm the key actually works
// BEFORE marking the connection active — not just "the request was well-formed."

import type { AppDefinition, Secrets } from "../../types";
import { search } from "./actions/search";

interface SerpApiAccountResponse {
  error?: string;
}

export const serpapiApp: AppDefinition = {
  id: "serpapi",
  name: "SerpApi",
  auth: {
    type: "api_key",
    fields: [{ name: "api_key", label: "SerpApi Key", required: true, secret: true }],
  },
  async testConnection(secrets: Secrets) {
    const apiKey = secrets.api_key;
    if (!apiKey) {
      throw new Error("Missing required field: api_key");
    }
    // /account.json is SerpApi's lightweight account-info endpoint — same auth failure shape as /search.json
    // (401 + { error }) but doesn't spend a search credit just to validate a key.
    const url = new URL("https://serpapi.com/account.json");
    url.searchParams.set("api_key", apiKey);
    const res = await fetch(url);
    const data = (await res.json()) as SerpApiAccountResponse;
    if (!res.ok || data.error) {
      throw new Error(`SerpApi key validation failed: ${data.error ?? res.statusText}`);
    }
  },
  actions: [search],
  triggers: [],
};

// No serpapi SDK — plain `fetch`, same "no SDK, keep it lite" approach as Gmail/Slack.

import { z } from "zod";
import type { ActionDefinition } from "../../../types";

const input = z.object({
  query: z.string().min(1),
  engine: z.string().default("google"), // SerpApi supports many engines; google is the sane default
  num_results: z.number().int().min(1).max(20).default(10),
});

const result = z.object({
  title: z.string(),
  link: z.string(),
  snippet: z.string().optional(),
});

const output = z.object({
  results: z.array(result),
});

type Input = z.infer<typeof input>;
type Output = z.infer<typeof output>;

interface SerpApiResponse {
  error?: string;
  organic_results?: { title: string; link: string; snippet?: string }[];
}

export const search: ActionDefinition<Input, Output> = {
  key: "search",
  description: "Run a search query via SerpApi and return the organic results.",
  input,
  output,
  async run(connection, params) {
    const apiKey = connection.secrets?.api_key;
    if (!apiKey) {
      throw new Error(`Connection ${connection.connection_id} has no api_key in secrets (not active yet?)`);
    }

    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", params.engine);
    url.searchParams.set("q", params.query);
    url.searchParams.set("num", String(params.num_results));
    url.searchParams.set("api_key", apiKey);

    const res = await fetch(url);
    const data = (await res.json()) as SerpApiResponse;

    // SerpApi uses real HTTP status codes (401 on bad key, etc.) unlike Slack's always-200 pattern —
    // still also check the `error` field since some failure modes (e.g. malformed query) come back on a
    // 200 with an `error` string instead of a non-2xx status.
    if (!res.ok || data.error) {
      throw new Error(`SerpApi search failed (${res.status}): ${data.error ?? res.statusText}`);
    }

    return {
      results: (data.organic_results ?? [])
        .slice(0, params.num_results)
        .map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })),
    };
  },
};

// Single source of truth for env vars. Parsed + validated once at import time (via zod, already a
// dependency — no new package needed) so a missing/malformed required var throws immediately on startup,
// before the server ever binds a port, instead of failing later inside whatever request first touches it.
// Bun.env is a plain object alias for process.env, and Bun already auto-loads .env — no `dotenv`.
//
// Every other file should import `config` from here instead of reading Bun.env/process.env directly.

import { z } from "zod";

const envSchema = z.object({
  // Actually binds the server (see src/server.ts) — BASE_URL below is a separate value (what OAuth
  // providers redirect back to / what connect_url is built from) that must be kept in sync with this by
  // hand when either changes, since one is "what port to listen on" and the other is "what URL is this
  // reachable at" (not always the same host/port once this sits behind a reverse proxy).
  PORT: z.coerce.number().int().positive().default(3005),
  BASE_URL: z.string().url().default("http://localhost:3005"),

  // No fallback on purpose — see src/lib/cipher.ts, which is the only file that ever reads this value out
  // of `config`. A missing/wrong-length key must fail loudly, not silently encrypt with a weak default.
  ENCRYPTION_KEY: z
    .string()
    .min(1, "ENCRYPTION_KEY is required — every Connection secret is encrypted at rest with it. Generate one with `openssl rand -base64 32`.")
    .refine((raw) => Buffer.from(raw, "base64").length === 32, {
      message: "ENCRYPTION_KEY must decode (base64) to exactly 32 bytes for AES-256. Generate with `openssl rand -base64 32`.",
    }),

  // TODO(ask), see src/server.ts — not wired into any route yet, so not enforced as required here either.
  AuthKey: z.string().optional(),

  SLACK_CLIENT_ID: z.string().optional().default(""),
  SLACK_CLIENT_SECRET: z.string().optional().default(""),

  GMAIL_CLIENT_ID: z.string().optional().default(""),
  GMAIL_CLIENT_SECRET: z.string().optional().default(""),

  // SerpApi is api_key-type — callers supply their own key at connect time (see .env.example), so nothing
  // shared to validate here.

  SERPER_API_KEY: z.string().optional().default(""),

  // Phase 4 storage backends — not wired into src/core/store.ts yet, kept permissive.
  STORAGE_DEFAULT: z.enum(["s3", "redis", "postgres"]).default("s3"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_BUCKET: z.string().optional(),
  AWS_REGION: z.string().default("ap-south-1"),

  REDIS_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
});

function loadEnv() {
  const result = envSchema.safeParse(Bun.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment configuration — check .env against .env.example:\n${issues}`);
  }
  return result.data;
}

const env = loadEnv();

// Keys deliberately match the .env var names verbatim (not camelCased) — config.apps.gmail.GMAIL_CLIENT_ID,
// not config.apps.gmail.clientId — so there's zero ambiguity when cross-referencing this object against
// .env/.env.example: same name, same casing, everywhere.
export const config = {
  PORT: env.PORT,
  BASE_URL: env.BASE_URL.replace(/\/$/, ""),

  security: {
    ENCRYPTION_KEY: env.ENCRYPTION_KEY,
    AuthKey: env.AuthKey,
  },

  apps: {
    slack: {
      SLACK_CLIENT_ID: env.SLACK_CLIENT_ID,
      SLACK_CLIENT_SECRET: env.SLACK_CLIENT_SECRET,
    },
    gmail: {
      GMAIL_CLIENT_ID: env.GMAIL_CLIENT_ID,
      GMAIL_CLIENT_SECRET: env.GMAIL_CLIENT_SECRET,
    },
    serpapi: {
      // bring-your-own-key at connect time — nothing platform-level to hold here
    },
  },

  SERPER_API_KEY: env.SERPER_API_KEY,

  storage: {
    STORAGE_DEFAULT: env.STORAGE_DEFAULT,
    aws: {
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
      AWS_BUCKET: env.AWS_BUCKET,
      AWS_REGION: env.AWS_REGION,
    },
  },

  REDIS_URL: env.REDIS_URL,
  DATABASE_URL: env.DATABASE_URL,
} as const;

export type Config = typeof config;

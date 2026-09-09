// S3-compatible object storage. Per CLAUDE.md: use Bun.S3Client (Bun.s3), no separate SDK needed.
//
// NOT wired into anything yet. Bun.s3 reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_BUCKET /
// AWS_REGION from env automatically (already in .env.example) — no client construction needed for the
// default bucket, `Bun.s3.file(key)` / `Bun.s3.write(key, data)` just work.

export const s3 = Bun.s3;

// TODO(ask): what actually needs to live in S3, concretely? `.env.example` already anticipates it
// (`STORAGE_DEFAULT=s3`) but nothing in the Phase 1-3 scope obviously needs object storage yet. Candidates,
// none confirmed:
// - Gmail attachments (send_email input / a future "get_attachment" action) — files, not JSON, don't
//   belong inline in a Postgres row or an action_logs entry.
// - Action log / audit export if action_logs (db.ts) grows large and old entries get archived out of
//   Postgres — unlikely to matter before Phase 4 has real usage data.
// - NOT credentials, NOT connection/user records — those stay in Postgres (db.ts), S3 has no place in the
//   auth-patterns.md encryption-at-rest story.
// Until one of these is confirmed as in-scope, treat this file as "the client is ready when needed", not
// "here's the abstraction" — resist adding upload/download helpers speculatively.

export async function pingS3(): Promise<boolean> {
  // TODO: cheap existence check (e.g. head the configured bucket), used by a future health-check route.
  throw new Error("not implemented");
}

# tool_provider_project

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.4.0. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Testing

Tests live in `test_components/<app>/...`, mirroring `src/components/<app>/...` rather than being colocated
with the source files.

```bash
bun test                              # everything
bun test test_components/slack        # one app only
bun test test_components/slack/actions/postMessage.test.ts   # one file
bun test test_components/slack -t "as_user"                  # by test name (regex)
```

Only `slack` has a test tree right now (`test_components/slack/`, 15 action tests + shared `testUtils.ts`
mock harness). `gmail` and `serpapi` have none yet — same `bun test test_components/<app>` pattern applies
once they exist.

## Known gaps / TODO

- **`serpapi` `testConnection` is a no-op** (`src/components/serpapi/app.ts`) — the real key-validation call
  to `/account.json` is commented out, so any non-empty string is currently accepted as a valid API key at
  connect time; a bad key is only discovered on the first real `search` action call instead.
- **No test coverage for `gmail` or `serpapi`** — only `slack` has a `test_components/` tree so far.
- **Slack user-token refresh**: if a Slack app has token rotation enabled, `src/core/tokenRefresh.ts` only
  refreshes the bot token (`secrets.access_token`), not the user token (`secrets.user_access_token`) used by
  `as_user`/`find_messages` — that token can go stale over time on a rotating app.

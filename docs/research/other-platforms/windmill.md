# Windmill

- **Repo**: [windmill-labs/windmill](https://github.com/windmill-labs/windmill) — AGPLv3 (fully open source; Windmill Labs sells dedicated-instance hosting/support commercially on top)
- **Stack**: Rust (execution engine/backend), Svelte (frontend), scripts run in Python, TypeScript, Go, Bash, SQL, GraphQL, PHP, C#, Rust
- **Discovered during**: broad open-source search — relevant as a "turn scripts into workflows/webhooks" platform with a built-in secrets/OAuth layer

## Architecture overview
Windmill is a code-first automation/internal-tools engine: any script (in one of ~8 supported languages) becomes a callable unit that can be composed into flows, exposed as a webhook, scheduled, or turned into an auto-generated UI/app. Positioned as a faster (claimed 13x vs Airflow) open-source alternative to Retool/Airflow/Temporal — broader scope than a pure tool-provider, but the **Resources** subsystem is directly relevant.

## Auth model
Windmill has a built-in **secret manager + OAuth platform**: "Resources" are typed credential objects (60+ pre-built integration templates — Slack, GitHub, AWS, GCP, Stripe, Postgres, etc.) that generate a secure credential-entry form per type, store secrets encrypted, and are referenced by scripts at runtime rather than embedded in code. This is a centralized/declarative approach (closer to Nango than to Activepieces' per-piece code).

## Trigger model
Flows/scripts can be invoked: on-demand (UI/API), via **webhook** (auto-generated URL per script/flow), or on a **schedule** (cron). No polling-trigger abstraction called out distinctly — webhook and schedule are the two primitives.

## Tool/schema definition format
Scripts declare their own parameter schema via native language typing (inferred at deploy time) rather than a separate manifest — Windmill infers input forms/JSON schema from the script's function signature. Less directly reusable as an MCP tool schema than Zapier/Activepieces' explicit field definitions, but notable for the "infer schema from code" approach as an alternative design.

## Notable code pointers
Not deep-dived at the file level in this pass (would need a follow-up read of the Resources/OAuth backend, likely in the Rust `backend/` service) — flagging for a later deeper read given the centralized secrets-manager approach is architecturally interesting for the auth-first priority.

## Takeaways
- **Worth borrowing**: the centralized "Resources" model — typed, pre-built credential templates with auto-generated secure forms — is a strong pattern for a platform-managed OAuth/credential layer (contrast with Activepieces' fully-decentralized per-piece auth code).
- **Worth a follow-up deep read**: since this project's stated priority is "OAuth/Auth flow first," Windmill's Resources + secret manager subsystem is one of the more centralized, battle-tested implementations found and deserves closer code-level inspection before finalizing the auth architecture.
- **Scope mismatch to note**: Windmill is broader than a tool-provider (full internal-tools/app-builder platform) — borrow the auth/trigger subsystem ideas, not the overall product shape.

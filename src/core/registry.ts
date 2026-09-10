// App registry: id -> AppDefinition. Phase 1: gmail + slack (oauth2) + serpapi (api_key).
// This is the "Apps" concept from ARCHITECTURE.md — each app.ts is self-contained (auth + actions + triggers).

import type { ActionDefinition, AppDefinition, AppId } from "../types";
import { gmailApp } from "../components/gmail/app";
import { slackApp } from "../components/slack/app";
import { serpapiApp } from "../components/serpapi/app";

const apps: Record<AppId, AppDefinition> = {
  gmail: gmailApp,
  slack: slackApp,
  serpapi: serpapiApp,
};

export function getApp(id: AppId): AppDefinition {
  const app = apps[id];
  if (!app) {
    // TODO(ask): typed error class (AppNotFoundError) vs plain Error, once we wire real HTTP error responses in server.ts?
    throw new Error(`Unknown app: ${id}`);
  }
  return app;
}

export function listApps(): AppDefinition[] {
  return Object.values(apps);
}

// Composio's real `tool_slug` shape (confirmed against .idea/composio.http: `SLACK_FIND_CHANNELS`,
// `POST /tools/execute/{tool_slug}`) — one flat, unambiguous identifier an agent can pass as a single
// string/enum value instead of two separate path segments. `app.id`/`action.key` never contain "_"
// themselves (see components/*/app.ts), so splitting back out in findByToolSlug() is unambiguous.
export function toolSlug(appId: string, actionKey: string): string {
  return `${appId}_${actionKey}`.toUpperCase();
}

export function findByToolSlug(slug: string): { app: AppDefinition; action: ActionDefinition } | null {
  for (const app of listApps()) {
    for (const action of app.actions as ActionDefinition[]) {
      if (toolSlug(app.id, action.key) === slug.toUpperCase()) {
        return { app, action };
      }
    }
  }
  return null;
}

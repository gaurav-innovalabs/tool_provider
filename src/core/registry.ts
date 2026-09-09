// App registry: id -> AppDefinition. Phase 1: gmail + slack (oauth2) + serpapi (api_key).
// This is the "Apps" concept from ARCHITECTURE.md — each app.ts is self-contained (auth + actions + triggers).

import type { AppDefinition, AppId } from "../types";
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

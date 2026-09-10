// Per-instance INPUT PROPS (TriggerDefinition.config/matchesConfig, types.ts) — the channel/thread scoping
// a subscriber configures at subscribe time (POST /triggers/slack/:trigger/subscribe's `config` field, see
// test_components/slack/slack.http). Pure functions, no network — unlike the Gmail poll trigger tests
// (../../gmail/triggers/*.test.ts), nothing here needs mockGmailFetch-style fetch mocking.

import { describe, test, expect } from "bun:test";
import { newMessage } from "../../../src/components/slack/triggers/newMessage";
import { messageEdited } from "../../../src/components/slack/triggers/messageEdited";
import { messageDeleted } from "../../../src/components/slack/triggers/messageDeleted";
import { reactionAdded } from "../../../src/components/slack/triggers/reactionAdded";
import { reactionRemoved } from "../../../src/components/slack/triggers/reactionRemoved";
import { userJoinedChannel } from "../../../src/components/slack/triggers/userJoinedChannel";
import { channelCreated } from "../../../src/components/slack/triggers/channelCreated";
import { fileShared } from "../../../src/components/slack/triggers/fileShared";

describe("newMessage config", () => {
  const event = { type: "message", channel: "C123", user: "U1", text: "hi", ts: "1.1", thread_ts: "0.9" };

  test("no config schema violation on a bare channel", () => {
    expect(newMessage.config!.parse({ channel_id: "C123" })).toEqual({ channel_id: "C123" });
  });

  test("rejects a non-string channel_id", () => {
    expect(() => newMessage.config!.parse({ channel_id: 123 })).toThrow();
  });

  test("matches when unscoped (empty config)", () => {
    expect(newMessage.matchesConfig!(event, {})).toBe(true);
  });

  test("matches on the right channel", () => {
    expect(newMessage.matchesConfig!(event, { channel_id: "C123" })).toBe(true);
  });

  test("rejects a different channel", () => {
    expect(newMessage.matchesConfig!(event, { channel_id: "C_OTHER" })).toBe(false);
  });

  test("matches on channel + thread_ts together", () => {
    expect(newMessage.matchesConfig!(event, { channel_id: "C123", thread_ts: "0.9" })).toBe(true);
  });

  test("rejects a different thread_ts even with the right channel", () => {
    expect(newMessage.matchesConfig!(event, { channel_id: "C123", thread_ts: "OTHER" })).toBe(false);
  });

  test("thread_ts filter rejects a top-level (non-reply) message with no thread_ts at all", () => {
    const topLevel = { ...event, thread_ts: undefined };
    expect(newMessage.matchesConfig!(topLevel, { thread_ts: "0.9" })).toBe(false);
  });
});

describe("messageEdited config", () => {
  const event = {
    type: "message",
    subtype: "message_changed" as const,
    channel: "C123",
    ts: "1.1",
    message: { text: "new", user: "U1", ts: "0.5", thread_ts: "0.9" },
  };

  test("matches on channel", () => {
    expect(messageEdited.matchesConfig!(event, { channel_id: "C123" })).toBe(true);
  });

  test("rejects a different channel", () => {
    expect(messageEdited.matchesConfig!(event, { channel_id: "C_OTHER" })).toBe(false);
  });

  test("matches on the nested message's thread_ts", () => {
    expect(messageEdited.matchesConfig!(event, { thread_ts: "0.9" })).toBe(true);
  });
});

describe("messageDeleted config", () => {
  const event = {
    type: "message",
    subtype: "message_deleted" as const,
    channel: "C123",
    ts: "1.1",
    deleted_ts: "0.5",
    previous_message: { text: "gone", user: "U1", ts: "0.5", thread_ts: "0.9" },
  };

  test("matches on channel", () => {
    expect(messageDeleted.matchesConfig!(event, { channel_id: "C123" })).toBe(true);
  });

  test("matches on previous_message's thread_ts", () => {
    expect(messageDeleted.matchesConfig!(event, { thread_ts: "0.9" })).toBe(true);
  });

  test("rejects a different thread_ts", () => {
    expect(messageDeleted.matchesConfig!(event, { thread_ts: "OTHER" })).toBe(false);
  });
});

describe("reactionAdded / reactionRemoved config (channel-only, no thread_ts)", () => {
  const event = { type: "reaction_added", user: "U1", reaction: "+1", item_user: "U2", item: { type: "message", channel: "C123", ts: "1.1" }, event_ts: "1.1" };

  test("reactionAdded matches on channel", () => {
    expect(reactionAdded.matchesConfig!(event, { channel_id: "C123" })).toBe(true);
  });

  test("reactionAdded rejects a different channel", () => {
    expect(reactionAdded.matchesConfig!(event, { channel_id: "C_OTHER" })).toBe(false);
  });

  test("reactionRemoved matches on channel", () => {
    expect(reactionRemoved.matchesConfig!({ ...event, type: "reaction_removed" }, { channel_id: "C123" })).toBe(true);
  });
});

describe("userJoinedChannel config", () => {
  const event = { type: "member_joined_channel", user: "U1", channel: "C123" };

  test("matches on channel", () => {
    expect(userJoinedChannel.matchesConfig!(event, { channel_id: "C123" })).toBe(true);
  });

  test("rejects a different channel", () => {
    expect(userJoinedChannel.matchesConfig!(event, { channel_id: "C_OTHER" })).toBe(false);
  });
});

describe("fileShared config", () => {
  const event = { type: "file_shared", channel_id: "C123", file_id: "F1", user_id: "U1", event_ts: "1.1" };

  test("matches on channel_id", () => {
    expect(fileShared.matchesConfig!(event, { channel_id: "C123" })).toBe(true);
  });

  test("rejects a different channel_id", () => {
    expect(fileShared.matchesConfig!(event, { channel_id: "C_OTHER" })).toBe(false);
  });

  test("matches when unscoped", () => {
    expect(fileShared.matchesConfig!(event, {})).toBe(true);
  });
});

describe("channelCreated — deliberately not scopable", () => {
  test("declares no config schema", () => {
    expect(channelCreated.config).toBeUndefined();
  });

  test("declares no matchesConfig", () => {
    expect(channelCreated.matchesConfig).toBeUndefined();
  });
});

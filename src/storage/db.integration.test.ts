import { existsSync, unlinkSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authSecrets,
  closeDb,
  groups,
  initDb,
  messages,
  multimodal,
  runtimeQueue,
  reminders,
  tasks,
  withConnection,
} from "./db";

const TEST_DB = "data/test.db";

function cleanupTestDb() {
  if (existsSync(TEST_DB)) {
    unlinkSync(TEST_DB);
  }
  if (existsSync(`${TEST_DB}-wal`)) {
    unlinkSync(`${TEST_DB}-wal`);
  }
  if (existsSync(`${TEST_DB}-shm`)) {
    unlinkSync(`${TEST_DB}-shm`);
  }
}

describe("Database", () => {
  beforeAll(() => {
    cleanupTestDb();
    initDb(TEST_DB);
  });

  afterAll(() => {
    closeDb();
    cleanupTestDb();
  });

  describe("Messages", () => {
    it("should create and retrieve a message", () => {
      const msg = {
        id: "msg1",
        channel: "telegram",
        chat_id: "chat1",
        sender_id: "user1",
        content: "hello",
        timestamp: new Date().toISOString(),
      };
      messages.create(msg);
      const retrieved = messages.getById("msg1");
      expect(retrieved).toBeDefined();
      expect(retrieved?.content).toBe("hello");
      expect(retrieved?.chat_id).toBe("chat1");
    });

    it("should list messages by chat_id", () => {
      const msgs = messages.listByChat("chat1");
      expect(msgs.length).toBeGreaterThan(0);
      expect(msgs[0].id).toBe("msg1");
    });
  });

  describe("Groups", () => {
    it("should create and retrieve a group", () => {
      const group = {
        id: "group1",
        channel: "telegram",
        chat_id: "chat1",
        name: "Test Group",
        folder: "test-group",
        is_main: 1,
      };
      groups.create(group);
      const retrieved = groups.getById("group1");
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe("Test Group");
      expect(retrieved?.is_main).toBe(1);
    });

    it("should get group by folder", () => {
      const retrieved = groups.getByFolder("test-group");
      expect(retrieved?.id).toBe("group1");
    });

    it("should update a group", () => {
      groups.update("group1", { name: "Updated Name" });
      const retrieved = groups.getById("group1");
      expect(retrieved?.name).toBe("Updated Name");
    });

    it("should list groups", () => {
      const list = groups.list();
      expect(list.length).toBe(1);
    });
  });

  describe("Tasks", () => {
    it("should create and retrieve a task", () => {
      const task = {
        id: "task1",
        group_id: "group1",
        prompt: "test prompt",
        schedule_type: "cron",
        schedule_value: "* * * * *",
        status: "active",
        last_run: null,
        next_run: null,
      };
      tasks.create(task);
      const retrieved = tasks.getById("task1");
      expect(retrieved).toBeDefined();
      expect(retrieved?.prompt).toBe("test prompt");
      expect(retrieved?.group_id).toBe("group1");
    });

    it("should list tasks by group_id", () => {
      const list = tasks.listByGroup("group1");
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("task1");
    });

    it("should update a task", () => {
      tasks.update("task1", { status: "completed" });
      const retrieved = tasks.getById("task1");
      expect(retrieved?.status).toBe("completed");
    });

    it("should delete a task", () => {
      tasks.delete("task1");
      const retrieved = tasks.getById("task1");
      expect(retrieved).toBeNull();
    });
  });

  describe("Constraints", () => {
    it("should enforce foreign key on tasks", () => {
      const invalidTask = {
        id: "task_invalid",
        group_id: "non_existent_group",
        prompt: "test prompt",
        schedule_type: "cron",
        schedule_value: "* * * * *",
        status: "active",
        last_run: null,
        next_run: null,
      };
      expect(() => tasks.create(invalidTask)).toThrow();
    });

    it("should enforce unique constraint on group folder", () => {
      const duplicateFolderGroup = {
        id: "group2",
        channel: "telegram",
        chat_id: "chat2",
        name: "Duplicate Folder Group",
        folder: "test-group", // Same as group1
        is_main: 0,
      };
      expect(() => groups.create(duplicateFolderGroup)).toThrow();
    });
  });

  describe("Runtime Queue", () => {
    it("enqueues, claims, and completes one item", () => {
      const now = new Date().toISOString();
      const enqueued = runtimeQueue.enqueue({
        id: "rq-1",
        dedupKey: "telegram:msg-1",
        sessionKey: "agent:mozi:telegram:dm:user1",
        channelId: "telegram",
        peerId: "user1",
        peerType: "dm",
        inboundJson: JSON.stringify({ id: "msg-1", text: "hello" }),
        enqueuedAt: now,
        availableAt: now,
      });
      expect(enqueued.inserted).toBe(true);

      const runnable = runtimeQueue.listRunnable(10);
      expect(runnable.length).toBeGreaterThan(0);
      expect(runnable[0].id).toBe("rq-1");

      const claimed = runtimeQueue.claim("rq-1");
      expect(claimed).toBe(true);

      runtimeQueue.markCompleted("rq-1");
      const item = runtimeQueue.getById("rq-1");
      expect(item?.status).toBe("completed");
    });

    it("deduplicates by dedup key", () => {
      const now = new Date().toISOString();
      const first = runtimeQueue.enqueue({
        id: "rq-dup-1",
        dedupKey: "telegram:dup-msg",
        sessionKey: "agent:mozi:telegram:dm:user2",
        channelId: "telegram",
        peerId: "user2",
        peerType: "dm",
        inboundJson: JSON.stringify({ id: "dup-msg", text: "hello 1" }),
        enqueuedAt: now,
        availableAt: now,
      });
      const second = runtimeQueue.enqueue({
        id: "rq-dup-2",
        dedupKey: "telegram:dup-msg",
        sessionKey: "agent:mozi:telegram:dm:user2",
        channelId: "telegram",
        peerId: "user2",
        peerType: "dm",
        inboundJson: JSON.stringify({ id: "dup-msg", text: "hello 2" }),
        enqueuedAt: now,
        availableAt: now,
      });
      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
    });
  });

  describe("Reminders", () => {
    it("creates, lists due, marks fired and cancels", () => {
      const now = new Date();
      const dueAt = new Date(now.getTime() - 1_000).toISOString();
      reminders.create({
        id: "rem-1",
        sessionKey: "agent:mozi:telegram:dm:user1",
        channelId: "telegram",
        peerId: "user1",
        peerType: "dm",
        message: "Reminder text",
        scheduleKind: "every",
        scheduleJson: JSON.stringify({ kind: "every", everyMs: 60_000, anchorMs: now.getTime() }),
        nextRunAt: dueAt,
      });

      const due = reminders.listDue(new Date().toISOString(), 10);
      expect(due.length).toBe(1);
      expect(due[0].id).toBe("rem-1");

      const nextRunAt = new Date(now.getTime() + 60_000).toISOString();
      const fired = reminders.markFired({
        id: "rem-1",
        expectedNextRunAt: dueAt,
        firedAt: now.toISOString(),
        nextRunAt,
        enabled: true,
      });
      expect(fired).toBe(true);

      const row = reminders.getById("rem-1");
      expect(row).not.toBeNull();
      expect(row?.last_run_at).toBe(now.toISOString());
      expect(row?.next_run_at).toBe(nextRunAt);

      const cancelled = reminders.cancel("rem-1");
      expect(cancelled).toBe(true);
      const after = reminders.getById("rem-1");
      expect(after?.enabled).toBe(0);
      expect(after?.cancelled_at).not.toBeNull();
    });

    it("supports scoped cancel and scoped updates", () => {
      const now = Date.now();
      const nextRunAt = new Date(now + 60_000).toISOString();
      reminders.create({
        id: "rem-scope-1",
        sessionKey: "agent:mozi:telegram:dm:user1",
        channelId: "telegram",
        peerId: "user1",
        peerType: "dm",
        message: "scope",
        scheduleKind: "every",
        scheduleJson: JSON.stringify({ kind: "every", everyMs: 60_000, anchorMs: now }),
        nextRunAt,
      });

      const cancelledWrong = reminders.cancelBySession(
        "rem-scope-1",
        "agent:mozi:telegram:dm:other",
      );
      expect(cancelledWrong).toBe(false);

      const updated = reminders.updateBySession({
        id: "rem-scope-1",
        sessionKey: "agent:mozi:telegram:dm:user1",
        message: "updated",
        scheduleKind: "at",
        scheduleJson: JSON.stringify({ kind: "at", atMs: now + 120_000 }),
        nextRunAt: new Date(now + 120_000).toISOString(),
      });
      expect(updated).toBe(true);

      const snoozed = reminders.updateNextRunBySession({
        id: "rem-scope-1",
        sessionKey: "agent:mozi:telegram:dm:user1",
        nextRunAt: new Date(now + 180_000).toISOString(),
      });
      expect(snoozed).toBe(true);

      const row = reminders.getById("rem-scope-1");
      expect(row?.message).toBe("updated");
      expect(row?.enabled).toBe(1);
      expect(row?.next_run_at).toBe(new Date(now + 180_000).toISOString());
    });
  });

  describe("Multimodal", () => {
    it("creates multimodal message, parts, media asset, and delivery attempts", () => {
      const createdAt = new Date().toISOString();
      multimodal.createMessage({
        id: "mm-msg-1",
        protocol_version: "2.0",
        tenant_id: "tenant-a",
        conversation_id: "conv-1",
        message_id: "m-100",
        direction: "inbound",
        source_channel: "telegram",
        source_channel_message_id: "tg-100",
        source_user_id: "u-1",
        correlation_id: "corr-1",
        trace_id: "trace-1",
        created_at: createdAt,
      });

      multimodal.upsertMediaAsset({
        id: "asset-1",
        tenant_id: "tenant-a",
        sha256: "abc123",
        mime_type: "image/png",
        byte_size: 1024,
        duration_ms: null,
        width: 200,
        height: 100,
        filename: "x.png",
        blob_uri: "file:///tmp/x.png",
        scan_status: "clean",
        created_at: createdAt,
      });

      multimodal.createMessageParts([
        {
          id: "mm-part-1",
          message_id: "mm-msg-1",
          idx: 0,
          role: "user",
          modality: "text",
          text: "hello",
          media_id: null,
          metadata_json: null,
        },
        {
          id: "mm-part-2",
          message_id: "mm-msg-1",
          idx: 1,
          role: "user",
          modality: "image",
          text: null,
          media_id: "asset-1",
          metadata_json: JSON.stringify({ source: "telegram" }),
        },
      ]);

      multimodal.createDeliveryAttempt({
        id: "mm-delivery-1",
        message_id: "mm-msg-1",
        channel: "telegram",
        attempt_no: 1,
        status: "completed",
        error_code: null,
        error_detail: null,
        sent_at: createdAt,
      });

      multimodal.createCapabilitySnapshot({
        id: "mm-cap-1",
        message_id: "mm-msg-1",
        channel_profile_json: JSON.stringify({ id: "channel:default" }),
        provider_profile_json: JSON.stringify({ id: "provider:default" }),
        policy_profile_json: JSON.stringify({ id: "policy:default" }),
        plan_json: JSON.stringify({ outputModalities: ["text"] }),
        created_at: createdAt,
      });

      multimodal.upsertRawEvent({
        id: "mm-raw-1",
        channel: "telegram",
        event_id: "tg-100",
        payload_json: JSON.stringify({ text: "hello" }),
        received_at: createdAt,
      });

      const counts = withConnection((conn) => {
        const messageCount = (
          conn
            .prepare("SELECT COUNT(*) AS count FROM multimodal_messages WHERE id = ?")
            .get("mm-msg-1") as { count: number }
        ).count;
        const partCount = (
          conn
            .prepare("SELECT COUNT(*) AS count FROM multimodal_message_parts WHERE message_id = ?")
            .get("mm-msg-1") as { count: number }
        ).count;
        const assetCount = (
          conn
            .prepare("SELECT COUNT(*) AS count FROM multimodal_media_assets WHERE id = ?")
            .get("asset-1") as { count: number }
        ).count;
        const deliveryCount = (
          conn
            .prepare("SELECT COUNT(*) AS count FROM multimodal_delivery_attempts WHERE id = ?")
            .get("mm-delivery-1") as { count: number }
        ).count;
        const snapshotCount = (
          conn
            .prepare("SELECT COUNT(*) AS count FROM multimodal_capability_snapshots WHERE id = ?")
            .get("mm-cap-1") as { count: number }
        ).count;
        const rawCount = (
          conn
            .prepare(
              "SELECT COUNT(*) AS count FROM multimodal_raw_events WHERE channel = ? AND event_id = ?",
            )
            .get("telegram", "tg-100") as { count: number }
        ).count;
        return { messageCount, partCount, assetCount, deliveryCount, snapshotCount, rawCount };
      });

      expect(counts).toEqual({
        messageCount: 1,
        partCount: 2,
        assetCount: 1,
        deliveryCount: 1,
        snapshotCount: 1,
        rawCount: 1,
      });
    });
  });

  describe("Auth Secrets", () => {
    it("upserts and reads exact/global secrets", () => {
      authSecrets.upsert({
        name: "TEST_API_KEY",
        scopeType: "global",
        valueCiphertext: Buffer.from("ciphertext-1"),
        valueNonce: Buffer.from("nonce-1"),
        createdBy: "tester",
      });

      const row = authSecrets.getExact({
        name: "TEST_API_KEY",
        scopeType: "global",
      });
      expect(row).not.toBeNull();
      expect(row?.name).toBe("TEST_API_KEY");
      expect(row?.scope_type).toBe("global");
    });

    it("resolves effective auth by agent scope before global", () => {
      authSecrets.upsert({
        name: "OPENAI_API_KEY",
        scopeType: "global",
        valueCiphertext: Buffer.from("global-cipher"),
        valueNonce: Buffer.from("global-nonce"),
      });
      authSecrets.upsert({
        name: "OPENAI_API_KEY",
        scopeType: "agent",
        scopeId: "mozi",
        valueCiphertext: Buffer.from("agent-cipher"),
        valueNonce: Buffer.from("agent-nonce"),
      });

      const effective = authSecrets.getEffective({ name: "OPENAI_API_KEY", agentId: "mozi" });
      expect(effective).not.toBeNull();
      expect(effective?.scope_type).toBe("agent");
      expect(effective?.scope_id).toBe("mozi");
    });

    it("deletes scoped secret", () => {
      authSecrets.upsert({
        name: "DELETE_ME",
        scopeType: "agent",
        scopeId: "mozi",
        valueCiphertext: Buffer.from("x"),
        valueNonce: Buffer.from("y"),
      });

      const removed = authSecrets.delete({
        name: "DELETE_ME",
        scopeType: "agent",
        scopeId: "mozi",
      });
      expect(removed).toBe(true);

      const after = authSecrets.getExact({
        name: "DELETE_ME",
        scopeType: "agent",
        scopeId: "mozi",
      });
      expect(after).toBeNull();
    });
  });
});

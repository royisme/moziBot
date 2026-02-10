import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { closeDb, initDb } from "../../../storage/db";
import { SessionManager } from "./manager";

const TEST_DB = "data/test-sessions.db";

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

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    cleanupTestDb();
    initDb(TEST_DB);
    manager = new SessionManager();
  });

  afterEach(() => {
    closeDb();
    cleanupTestDb();
  });

  test("should build and parse keys correctly", () => {
    const key = SessionManager.buildKey("agent1", "telegram", "dm", "user1");
    expect(key).toBe("agent1:telegram:dm:user1");

    const parsed = SessionManager.parseKey(key);
    expect(parsed).toEqual({
      agentId: "agent1",
      channel: "telegram",
      type: "dm",
      peerId: "user1",
    });
  });

  test("should create a new session", async () => {
    const key = "agent1:telegram:dm:user1";
    const session = await manager.getOrCreate(key, { peerType: "dm" });

    expect(session.key).toBe(key);
    expect(session.agentId).toBe("agent1");
    expect(session.status).toBe("idle");
    expect(manager.get(key)).toBe(session);
  });

  test("should be idempotent for getOrCreate", async () => {
    const key = "agent1:telegram:dm:user1";
    const s1 = await manager.getOrCreate(key, { peerType: "dm" });
    const s2 = await manager.getOrCreate(key, { peerType: "dm" });

    expect(s1).toBe(s2);
    expect(manager.list().length).toBe(1);
  });

  test("should filter sessions", async () => {
    await manager.getOrCreate("a1:c1:dm:p1", { status: "idle" });
    await manager.getOrCreate("a1:c2:dm:p2", { status: "running" });
    await manager.getOrCreate("a2:c1:dm:p3", { status: "idle" });

    expect(manager.list({ agentId: "a1" }).length).toBe(2);
    expect(manager.list({ channel: "c1" }).length).toBe(2);
    expect(manager.list({ status: "running" }).length).toBe(1);
  });

  test("should handle parent-child relationships", async () => {
    const parentKey = "main:t:dm:p1";
    await manager.getOrCreate(parentKey, {});

    const childKey = "sub:t:dm:p1";
    await manager.getOrCreate(childKey, { parentKey });

    const children = manager.getChildren(parentKey);
    expect(children.length).toBe(1);
    expect(children[0].key).toBe(childKey);
  });

  test("should update session properties", async () => {
    const key = "a1:t:dm:p1";
    await manager.getOrCreate(key, { status: "idle" });

    const updated = await manager.update(key, {
      status: "running",
      metadata: { foo: "bar" },
    });
    expect(updated?.status).toBe("running");
    expect(updated?.metadata).toEqual({ foo: "bar" });

    const session = manager.get(key);
    expect(session?.status).toBe("running");
  });

  test("should persist and load sessions", async () => {
    const key = "persist:test:dm:1";
    await manager.getOrCreate(key, {
      status: "running",
      metadata: { saved: true },
    });

    // Create new manager instance to test loading
    const manager2 = new SessionManager();
    await manager2.load();

    const loaded = manager2.get(key);
    expect(loaded).toBeDefined();
    expect(loaded?.key).toBe(key);
    expect(loaded?.status).toBe("running");
    expect(loaded?.metadata).toEqual({ saved: true });
  });

  test("should delete sessions", async () => {
    const key = "del:test:dm:1";
    await manager.getOrCreate(key, {});
    expect(manager.get(key)).toBeDefined();

    const deleted = await manager.delete(key);
    expect(deleted).toBe(true);
    expect(manager.get(key)).toBeUndefined();

    // Check DB
    const manager2 = new SessionManager();
    await manager2.load();
    expect(manager2.get(key)).toBeUndefined();
  });
});

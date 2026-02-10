import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { closeDb, initDb } from "../../../storage/db";
import { SessionManager } from "./manager";
import { SubAgentRegistry, spawnSubAgent } from "./spawn";

const TEST_DB = "data/test-spawn.db";

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

describe("SubAgent Spawn", () => {
  let manager: SessionManager;
  let registry: SubAgentRegistry;

  beforeEach(() => {
    cleanupTestDb();
    initDb(TEST_DB);
    manager = new SessionManager();
    registry = new SubAgentRegistry();
  });

  afterEach(() => {
    closeDb();
    cleanupTestDb();
  });

  test("spawn creates child session", async () => {
    const parentKey = "agent1:telegram:dm:user1";
    await manager.getOrCreate(parentKey, {});

    const result = await spawnSubAgent(manager, registry, {
      parentKey,
      task: "test task",
      cleanup: "keep",
    });

    expect(result.status).toBe("accepted");
    expect(result.childKey).toContain("agent1:subagent:dm:");

    const childSession = manager.get(result.childKey);
    expect(childSession).toBeDefined();
    expect(childSession?.parentKey).toBe(parentKey);
    expect(childSession?.metadata?.task).toBe("test task");
  });

  test("child has correct parentKey", async () => {
    const parentKey = "agent1:telegram:dm:user1";
    await manager.getOrCreate(parentKey, {});

    const result = await spawnSubAgent(manager, registry, {
      parentKey,
      task: "another task",
      cleanup: "keep",
    });

    const children = manager.getChildren(parentKey);
    expect(children.length).toBe(1);
    expect(children[0].key).toBe(result.childKey);
  });

  test("registry tracks runs", async () => {
    const parentKey = "agent1:telegram:dm:user1";
    await manager.getOrCreate(parentKey, {});

    const result = await spawnSubAgent(manager, registry, {
      parentKey,
      task: "tracked task",
      cleanup: "keep",
      label: "my label",
    });

    const run = registry.get(result.childKey);
    expect(run).toBeDefined();
    expect(run?.task).toBe("tracked task");
    expect(run?.label).toBe("my label");
    expect(run?.status).toBe("pending");

    const runs = registry.listByParent(parentKey);
    expect(runs.length).toBe(1);
    expect(runs[0].childKey).toBe(result.childKey);
  });

  test("complete updates status", async () => {
    const parentKey = "agent1:telegram:dm:user1";
    await manager.getOrCreate(parentKey, {});

    const result = await spawnSubAgent(manager, registry, {
      parentKey,
      task: "completing task",
      cleanup: "keep",
    });

    registry.complete(result.childKey, {
      status: "completed",
      result: "success result",
    });

    const run = registry.get(result.childKey);
    expect(run?.status).toBe("completed");
    expect(run?.result).toBe("success result");
    expect(run?.completedAt).toBeDefined();
  });

  test("nested spawn is rejected", async () => {
    // A session with channel 'subagent' is considered a subagent
    const subAgentKey = "agent1:subagent:dm:uuid123";
    await manager.getOrCreate(subAgentKey, {});

    const result = await spawnSubAgent(manager, registry, {
      parentKey: subAgentKey,
      task: "nested task",
      cleanup: "keep",
    });

    expect(result.status).toBe("rejected");
    expect(result.error).toBe("Nested subagent spawning is not allowed");
  });

  test("cleanup removes session if requested", async () => {
    const parentKey = "agent1:telegram:dm:user1";
    await manager.getOrCreate(parentKey, {});

    const result = await spawnSubAgent(manager, registry, {
      parentKey,
      task: "cleanup task",
      cleanup: "delete",
    });

    expect(registry.get(result.childKey)).toBeDefined();

    registry.cleanup(result.childKey);
    expect(registry.get(result.childKey)).toBeUndefined();

    // Note: The registry cleanup currently only removes from registry.
    // If we wanted it to also remove from SessionManager, we would need to call manager.delete()
    // but the requirements say "Cleanup completed runs based on policy" in SubAgentRegistry.
  });
});

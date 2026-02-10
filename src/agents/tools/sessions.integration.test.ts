import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionManager } from "../../runtime/host/sessions/manager";
import { SubAgentRegistry } from "../../runtime/host/sessions/spawn";
import { closeDb, initDb } from "../../storage/db";
import { type SessionToolsContext, sessionsList, sessionsSend, sessionsSpawn } from "./sessions";

const TEST_DB = "data/test-session-tools.db";

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

describe("Session Tools", () => {
  let sessionManager: SessionManager;
  let subAgentRegistry: SubAgentRegistry;
  let ctx: SessionToolsContext;

  beforeEach(async () => {
    cleanupTestDb();
    initDb(TEST_DB);

    sessionManager = new SessionManager();
    subAgentRegistry = new SubAgentRegistry();

    // Create a dummy current session
    const currentSessionKey = "agent1:telegram:dm:user1";
    await sessionManager.getOrCreate(currentSessionKey, {});

    ctx = {
      sessionManager,
      subAgentRegistry,
      currentSessionKey,
    };
  });

  afterEach(() => {
    closeDb();
    cleanupTestDb();
  });

  test("sessions_list returns sessions", async () => {
    await sessionManager.getOrCreate("agent1:telegram:dm:user2", {});

    const result = await sessionsList(ctx, {});
    expect(result.sessions.length).toBe(2);
    expect(result.sessions[0]).toHaveProperty("key");
    expect(result.sessions[0]).toHaveProperty("status");
  });

  test("sessions_list filters work", async () => {
    await sessionManager.getOrCreate("agent1:discord:dm:user1", {
      status: "running",
    });
    await sessionManager.getOrCreate("agent2:telegram:dm:user1", {
      status: "idle",
    });

    const discordResult = await sessionsList(ctx, { channel: "discord" });
    expect(discordResult.sessions.length).toBe(1);
    expect(discordResult.sessions[0].channel).toBe("discord");

    const agent2Result = await sessionsList(ctx, { agentId: "agent2" });
    expect(agent2Result.sessions.length).toBe(1);
    expect(agent2Result.sessions[0].agentId).toBe("agent2");

    const runningResult = await sessionsList(ctx, { status: "running" });
    expect(runningResult.sessions.length).toBe(1);
    expect(runningResult.sessions[0].status).toBe("running");
  });

  test("sessions_spawn calls spawnSubAgent", async () => {
    const result = await sessionsSpawn(ctx, {
      task: "test task",
      label: "subagent-1",
    });

    expect(result.status).toBe("accepted");
    expect(result.childKey).toContain("subagent");

    const childSession = sessionManager.get(result.childKey);
    expect(childSession).toBeDefined();
    expect(childSession?.parentKey).toBe(ctx.currentSessionKey);

    const run = subAgentRegistry.get(result.childKey);
    expect(run).toBeDefined();
    expect(run?.task).toBe("test task");
    expect(run?.label).toBe("subagent-1");
  });

  test("sessions_send updates target session status", async () => {
    const targetKey = "agent1:telegram:dm:user2";
    await sessionManager.getOrCreate(targetKey, { status: "idle" });

    const result = await sessionsSend(ctx, {
      sessionKey: targetKey,
      message: "hello",
    });

    expect(result.delivered).toBe(true);
    const updatedSession = sessionManager.get(targetKey);
    expect(updatedSession?.status).toBe("queued");
  });

  test("sessions_send can find target by label", async () => {
    const spawnResult = await sessionsSpawn(ctx, {
      task: "subtask",
      label: "worker-1",
    });

    // Reset status to idle for testing update
    await sessionManager.setStatus(spawnResult.childKey, "idle");

    const result = await sessionsSend(ctx, {
      label: "worker-1",
      message: "do work",
    });

    expect(result.delivered).toBe(true);
    const updatedSession = sessionManager.get(spawnResult.childKey);
    expect(updatedSession?.status).toBe("queued");
  });
});

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import type { ChannelPlugin } from "./runtime/adapters/channels/plugin";
import { AgentExecutor } from "./agents/runner";
import { SkillLoader } from "./agents/skills/loader";
import { ChannelRegistry } from "./runtime/adapters/channels/registry";
import { AgentBindings } from "./runtime/host/agents/bindings";
import { ConfigManager } from "./runtime/host/config-manager";
import { CronScheduler } from "./runtime/host/cron/scheduler";
import { SessionManager } from "./runtime/host/sessions/manager";
import { closeDb, initDb } from "./storage/db";

describe("Mozi Integration", () => {
  const TEST_DIR = join(process.cwd(), ".test-integration");
  const DB_PATH = join(TEST_DIR, "test.db");

  beforeAll(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
    process.env.LLM_API_KEY = "test-key";
    // Write valid config with new schema format
    writeFileSync(
      join(TEST_DIR, "mozi.config.json"),
      JSON.stringify({
        meta: { version: "1.0.0" },
      }),
    );
    initDb(DB_PATH);
  });

  afterAll(() => {
    closeDb();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // Test that all components can be instantiated together
  test("components initialize without errors", () => {
    const configPath = join(TEST_DIR, "mozi.config.json");
    const configManager = new ConfigManager(configPath);
    const sessionManager = new SessionManager();
    const agentBindings = new AgentBindings();
    const channelRegistry = new ChannelRegistry();
    const agentExecutor = new AgentExecutor({
      containerImage: "mozi-agent:latest",
      containerBackend: "docker",
      defaultModel: "quotio/gemini-3-flash-preview",
    });
    const cronScheduler = new CronScheduler();
    const skillLoader = new SkillLoader(join(TEST_DIR, "skills"));

    expect(configManager).toBeDefined();
    expect(sessionManager).toBeDefined();
    expect(agentBindings).toBeDefined();
    expect(channelRegistry).toBeDefined();
    expect(agentExecutor).toBeDefined();
    expect(cronScheduler).toBeDefined();
    expect(skillLoader).toBeDefined();
  });

  // Test session + agent binding flow
  test("session routes to correct agent via bindings", async () => {
    const agentBindings = new AgentBindings();

    agentBindings.load({
      agents: [
        { id: "main", name: "Main Agent", workspace: "/tmp" },
        {
          id: "coder",
          name: "Coder Agent",
          workspace: "/tmp",
          model: "quotio/gemini-3-flash-preview",
        },
      ],
      bindings: [
        {
          agentId: "coder",
          match: { channel: "discord", peer: { id: "12345", kind: "group" } },
        },
      ],
      defaultAgent: "main",
    });

    const sessionManager = new SessionManager();

    // Resolve for matched binding
    const agent1 = agentBindings.resolve({
      channel: "discord",
      peerId: "12345",
      peerKind: "group",
    });
    expect(agent1.id).toBe("coder");

    // Resolve for default
    const agent2 = agentBindings.resolve({
      channel: "telegram",
      peerId: "67890",
      peerKind: "dm",
    });
    expect(agent2.id).toBe("main");

    const key = SessionManager.buildKey(agent1.id, "discord", "group", "12345");
    const session = await sessionManager.getOrCreate(key, { peerType: "group" });
    expect(session.agentId).toBe("coder");
    expect(session.channel).toBe("discord");
  });

  // Test channel registry with mock plugin
  test("channel registry routes messages", async () => {
    const registry = new ChannelRegistry();
    let receivedMsg: unknown = null;

    registry.setMessageHandler((msg) => {
      receivedMsg = msg;
    });

    class MockPlugin extends EventEmitter {
      id = "mock";
      name = "Mock Plugin";
      async connect() {}
      async disconnect() {}
    }

    const plugin = new MockPlugin();
    registry.register(plugin as unknown as ChannelPlugin);

    const testMsg = {
      id: "msg1",
      channelId: "mock",
      peerId: "user1",
      peerType: "dm" as const,
      content: { type: "text" as const, text: "hello" },
      timestamp: new Date(),
    };

    plugin.emit("message", testMsg);

    expect(receivedMsg).toEqual(testMsg);
  });
});

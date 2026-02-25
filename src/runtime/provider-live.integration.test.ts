import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/loader";
import { AgentManager } from "./agent-manager";
import { renderAssistantReply } from "./host/reply-utils";
import { ModelRegistry } from "./model-registry";
import { ProviderRegistry } from "./provider-registry";
import { SessionStore } from "./session-store";

const LIVE_ENABLED = process.env.MOZI_LIVE_PROVIDER === "1";

describe("provider live smoke", () => {
  const testLive = LIVE_ENABLED ? it : it.skip;

  testLive("runs one real provider turn using local config", async () => {
    const configPath = process.env.MOZI_CONFIG;
    const configResult = loadConfig(configPath);
    if (!configResult.success || !configResult.config) {
      throw new Error(`Config load failed: ${configResult.errors?.join(", ") ?? "unknown error"}`);
    }

    const config = configResult.config;
    const agents = (config.agents ?? {}) as Record<string, unknown>;
    const entries = Object.entries(agents).filter(([id]) => id !== "defaults");
    const mainEntry = entries.find(([, entry]) => (entry as { main?: boolean }).main === true);
    const agentId = mainEntry?.[0] ?? entries[0]?.[0] ?? "mozi";

    const sessions = new SessionStore(config);
    const modelRegistry = new ModelRegistry(config);
    const providerRegistry = new ProviderRegistry(config);
    const manager = new AgentManager({
      config,
      modelRegistry,
      providerRegistry,
      sessions,
    });

    const sessionKey = `agent:${agentId}:local:dm:live-${Date.now()}`;
    const { agent, modelRef } = await manager.getAgent(sessionKey, agentId);
    expect(modelRef).toBeTruthy();

    await agent.prompt("Reply with a single word: PONG. Do not call tools.");

    const lastAssistant = agent.messages
      .toReversed()
      .find((msg) => (msg as { role?: string }).role === "assistant");
    const reply = renderAssistantReply(
      (lastAssistant as { content?: unknown } | undefined)?.content,
    ).trim();

    expect(reply.length).toBeGreaterThan(0);
    expect(reply.toLowerCase()).toContain("pong");
  });
});

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MoziConfig } from "../../../../config";
import { prepareRuntimeTestHarness } from "../../../../../tests/harness/runtime-test-harness";
import { HOME_FILES } from "../../../../agents/home";
import { extractIdentityLanguageHintFromSystemPrompt } from "./reset-greeting-language";
import { handleNewSessionCommand } from "./session-control-command";

describe("handleNewSessionCommand integration", () => {
  let homeDir = "";
  let config: MoziConfig;

  beforeAll(async () => {
    const harness = await prepareRuntimeTestHarness({
      suiteId: "session-control-command",
      ensureBootstrapFiles: true,
    });
    homeDir = harness.homeDir;
    config = harness.config;

    await fs.writeFile(
      path.join(homeDir, HOME_FILES.IDENTITY),
      [
        "# IDENTITY.md - Who Am I?",
        "",
        "- **Name:** Luka",
        "- **Creature:** AI assistant",
        "- **Vibe:** pragmatic",
        "- **Preferred Language:** zh-CN",
        "- **Emoji:** 🤖",
        "",
      ].join("\n"),
      "utf-8",
    );
  });

  it("uses zh fallback text for /new when identity preference is zh-CN", async () => {
    const identityContent = await fs.readFile(path.join(homeDir, HOME_FILES.IDENTITY), "utf-8");
    const systemPrompt = `# Identity & Persona\n## IDENTITY.md\n${identityContent}`;
    const identityLanguageHint = extractIdentityLanguageHintFromSystemPrompt(systemPrompt);
    expect(identityLanguageHint).toBe("zh-CN");

    const sentTexts: string[] = [];
    const getAgent = vi.fn(async () => ({ agent: { messages: [] as AgentMessage[] } }));
    const updateSessionMetadata = vi.fn();
    const resetSession = vi.fn();
    const compactSession = vi.fn(async () => ({ success: true, tokensReclaimed: 0 }));
    const flushMemory = vi.fn(async () => true);

    await handleNewSessionCommand({
      sessionKey: "agent:mozi:telegram:dm:chat-1",
      agentId: "mozi",
      channel: {
        send: async (_peerId, payload) => {
          sentTexts.push(payload.text);
        },
      },
      peerId: "chat-1",
      config,
      agentManager: {
        getAgent,
        updateSessionMetadata,
        resetSession,
        compactSession,
      },
      flushMemory,
      runResetGreetingTurn: async () => ({ text: "   " }),
      identityLanguageHint,
    });

    expect(sentTexts.at(-1)).toBe("新会话已开始（已切换到新的会话分段）。");
    expect(resetSession).toHaveBeenCalledWith("agent:mozi:telegram:dm:chat-1", "mozi");
  });
});

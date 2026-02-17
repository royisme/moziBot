import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MoziConfig } from "../../../config";
import { clearRuntimeHooks, getRuntimeHookRunner } from "../index";
import {
  configureMemoryMaintainerHooks,
  resetMemoryMaintainerHooksForTests,
} from "./memory-maintainer";

function createConfig(baseDir: string, homeDir: string): MoziConfig {
  return {
    paths: {
      baseDir,
      sessions: path.join(baseDir, "sessions"),
    },
    agents: {
      defaults: {
        model: "quotio/gemini-3-flash-preview",
      },
      mozi: {
        main: true,
        home: homeDir,
        workspace: path.join(baseDir, "workspace"),
      },
    },
  } as unknown as MoziConfig;
}

describe("memory maintainer bundled hooks", () => {
  let tempDir = "";
  let homeDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-memory-maintainer-"));
    homeDir = path.join(tempDir, "home");
    await fs.mkdir(homeDir, { recursive: true });
    clearRuntimeHooks();
    resetMemoryMaintainerHooksForTests();
  });

  afterEach(async () => {
    clearRuntimeHooks();
    resetMemoryMaintainerHooksForTests();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("writes MEMORY.md after turn threshold", async () => {
    configureMemoryMaintainerHooks(createConfig(tempDir, homeDir));
    const runner = getRuntimeHookRunner();

    for (let i = 1; i <= 3; i += 1) {
      await runner.runTurnCompleted(
        {
          traceId: `turn-${i}`,
          messageId: `m-${i}`,
          status: "success",
          durationMs: 10,
          userText: `user turn ${i}`,
          replyText: `assistant turn ${i}`,
        },
        {
          sessionKey: "agent:mozi:telegram:dm:chat-1",
          agentId: "mozi",
        },
      );
    }

    const memoryText = await fs.readFile(path.join(homeDir, "MEMORY.md"), "utf-8");
    expect(memoryText).toContain("## Auto Memory");
    expect(memoryText).toContain("User: user turn 1");
    expect(memoryText).toContain("Assistant: assistant turn 3");

    const date = new Date().toISOString().split("T")[0];
    const archiveText = await fs.readFile(path.join(homeDir, "memory", `${date}.md`), "utf-8");
    expect(archiveText).toContain("turn_completed");
  });

  it("flushes reset messages on before_reset even below turn threshold", async () => {
    configureMemoryMaintainerHooks(createConfig(tempDir, homeDir));
    const runner = getRuntimeHookRunner();

    await runner.runTurnCompleted(
      {
        traceId: "turn-a",
        messageId: "m-a",
        status: "success",
        durationMs: 10,
        userText: "short context",
        replyText: "short reply",
      },
      {
        sessionKey: "agent:mozi:telegram:dm:chat-1",
        agentId: "mozi",
      },
    );

    const messages: AgentMessage[] = [
      { role: "user", content: "Need remember project decision" } as AgentMessage,
      { role: "assistant", content: "Decision captured and agreed" } as AgentMessage,
    ];

    await runner.runBeforeReset(
      {
        reason: "new",
        messages,
      },
      {
        sessionKey: "agent:mozi:telegram:dm:chat-1",
        agentId: "mozi",
      },
    );

    const memoryText = await fs.readFile(path.join(homeDir, "MEMORY.md"), "utf-8");
    expect(memoryText).toContain("Reason: new");
    expect(memoryText).toContain("Need remember project decision");
    expect(memoryText).toContain("Decision captured and agreed");
  });
});

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { FlushManager } from "./flush-manager";

describe("FlushManager", () => {
  let homeDir: string;
  let manager: FlushManager;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-flush-test-"));
    manager = new FlushManager(homeDir);
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("flushes messages to a markdown file", async () => {
    const config = {
      enabled: true,
      onOverflowCompaction: true,
      onNewReset: true,
      maxMessages: 2,
      maxChars: 1000,
      timeoutMs: 1500,
    };

    const messages: AgentMessage[] = [
      { role: "user" as const, content: [{ type: "text", text: "hello" }], timestamp: Date.now() },
      {
        role: "assistant" as const,
        content: [{ type: "text", text: "hi there" }],
        timestamp: Date.now(),
        api: "openai-responses",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          totalTokens: 0,
          cacheWrite: 0,
          cacheRead: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      },
    ];

    const success = await manager.flush({
      messages,
      config,
      sessionKey: "test-session",
    });

    expect(success).toBe(true);

    const date = new Date().toISOString().split("T")[0];
    const targetFile = path.join(homeDir, "memory", `${date}.md`);
    const content = await fs.readFile(targetFile, "utf-8");

    expect(content).toContain("Session Flush");
    expect(content).toContain("**User:** hello");
    expect(content).toContain("**Assistant:** hi there");
  });

  it("respects maxMessages limit", async () => {
    const config = {
      enabled: true,
      onOverflowCompaction: true,
      onNewReset: true,
      maxMessages: 1,
      maxChars: 1000,
      timeoutMs: 1500,
    };

    const messages: AgentMessage[] = [
      { role: "user" as const, content: [{ type: "text", text: "first" }], timestamp: Date.now() },
      { role: "user" as const, content: [{ type: "text", text: "second" }], timestamp: Date.now() },
    ];

    await manager.flush({
      messages,
      config,
      sessionKey: "test-session",
    });

    const date = new Date().toISOString().split("T")[0];
    const content = await fs.readFile(path.join(homeDir, "memory", `${date}.md`), "utf-8");

    expect(content).not.toContain("first");
    expect(content).toContain("second");
  });

  it("returns false if disabled", async () => {
    const config = {
      enabled: false,
      onOverflowCompaction: true,
      onNewReset: true,
      maxMessages: 10,
      maxChars: 1000,
      timeoutMs: 1500,
    };

    const success = await manager.flush({
      messages: [{ role: "user", content: "test", timestamp: Date.now() }],
      config,
      sessionKey: "test",
    });

    expect(success).toBe(false);
  });
});

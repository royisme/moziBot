import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MoziConfig } from "../../../config";
import { clearRuntimeHooks, getRuntimeHookRunner } from "../index";
import {
  configureMemoryMaintainerHooks,
  resetMemoryMaintainerHooksForTests,
} from "./memory-maintainer";
import { MemoryInboxStore } from "../../../memory/governance/inbox-store";
import type { MemoryCandidate } from "../../../memory/governance/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForMemoryFiles(dir: string, timeoutMs = 2000): Promise<string[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const files = await fs.readdir(dir);
      if (files.length > 0) {
        return files;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for session memory snapshot in ${dir}`);
}

/** Read inbox shard for a given date using MemoryInboxStore. */
function makeInboxStore(homeDir: string): MemoryInboxStore {
  return new MemoryInboxStore(path.join(homeDir, "memory"));
}

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
    memory: {
      governance: {
        maintenanceAutoRun: true,
        dailyCompilerDebounceMs: 0,
      },
    },
  } as unknown as MoziConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory maintainer bundled hooks (governed pipeline)", () => {
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

  // -------------------------------------------------------------------------
  // turn_completed → inbox
  // -------------------------------------------------------------------------

  it("submits candidates to inbox after turn threshold (does NOT write MEMORY.md)", async () => {
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

    // MEMORY.md must NOT be written by the governed pipeline
    const memoryMdExists = await fs
      .access(path.join(homeDir, "MEMORY.md"))
      .then(() => true)
      .catch(() => false);
    expect(memoryMdExists).toBe(false);

    // Inbox shard should contain the candidate
    const date = new Date().toISOString().split("T")[0];
    const records: MemoryCandidate[] = await makeInboxStore(homeDir).readShard(date);
    expect(records.length).toBeGreaterThan(0);

    // Candidate summary should contain the turn text
    const summaries = records.map((r) => r.summary);
    const hasTurnText = summaries.some(
      (s) => s.includes("user turn") || s.includes("assistant turn"),
    );
    expect(hasTurnText).toBe(true);
  });

  it("does not submit candidates below the turn threshold", async () => {
    configureMemoryMaintainerHooks(createConfig(tempDir, homeDir));
    const runner = getRuntimeHookRunner();

    // Only 2 turns (below MIN_TURNS_BEFORE_FLUSH = 3)
    for (let i = 1; i <= 2; i += 1) {
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

    const inboxDate1 = new Date().toISOString().split("T")[0];
    const records: MemoryCandidate[] = await makeInboxStore(homeDir).readShard(inboxDate1);
    expect(records.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // before_reset → inbox
  // -------------------------------------------------------------------------

  it("submits before_reset messages to inbox (does NOT write MEMORY.md)", async () => {
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
      { role: "assistant", content: "Decision captured and agreed" } as unknown as AgentMessage,
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

    // MEMORY.md must NOT be written
    const memoryMdExists = await fs
      .access(path.join(homeDir, "MEMORY.md"))
      .then(() => true)
      .catch(() => false);
    expect(memoryMdExists).toBe(false);

    // Inbox should have candidates from the before_reset messages
    const date2 = new Date().toISOString().split("T")[0];
    const records: MemoryCandidate[] = await makeInboxStore(homeDir).readShard(date2);
    expect(records.length).toBeGreaterThan(0);

    const summaries = records.map((r) => r.summary);
    const hasResetText = summaries.some(
      (s) =>
        s.includes("Need remember project decision") || s.includes("Decision captured and agreed"),
    );
    expect(hasResetText).toBe(true);
  });

  it("before_reset candidates have source=before_reset", async () => {
    configureMemoryMaintainerHooks(createConfig(tempDir, homeDir));
    const runner = getRuntimeHookRunner();

    const messages: AgentMessage[] = [
      { role: "user", content: "important decision" } as AgentMessage,
    ];

    await runner.runBeforeReset(
      { reason: "new", messages },
      { sessionKey: "agent:mozi:telegram:dm:chat-1", agentId: "mozi" },
    );

    const date3 = new Date().toISOString().split("T")[0];
    const records: MemoryCandidate[] = await makeInboxStore(homeDir).readShard(date3);
    const sources = records.map((r) => r.source);
    expect(sources.every((s) => s === "before_reset")).toBe(true);
  });

  it("rewrites daily memory after before_reset governance acceptance", async () => {
    configureMemoryMaintainerHooks(createConfig(tempDir, homeDir));
    const runner = getRuntimeHookRunner();

    await runner.runBeforeReset(
      {
        reason: "new",
        messages: [{ role: "user", content: "important decision" } as AgentMessage],
      },
      { sessionKey: "agent:mozi:telegram:dm:chat-1", agentId: "mozi" },
    );

    const date = new Date().toISOString().split("T")[0];
    const records: MemoryCandidate[] = await makeInboxStore(homeDir).readShard(date);
    const dailyText = await fs.readFile(path.join(homeDir, "memory", "daily", `${date}.md`), "utf8");

    expect(records[0]?.status).toBe("accepted_daily");
    expect(dailyText).toContain(`# Daily Memory ${date}`);
    expect(dailyText).toContain("## Active Work");
    expect(dailyText).toContain("- User: important decision");
  });

  it("does NOT run governance maintenance immediately when dailyCompilerDebounceMs > 0", async () => {
    const cfg = createConfig(tempDir, homeDir);
    cfg.memory!.governance!.dailyCompilerDebounceMs = 100;
    configureMemoryMaintainerHooks(cfg);
    const runner = getRuntimeHookRunner();

    await runner.runBeforeReset(
      {
        reason: "new",
        messages: [{ role: "user", content: "decision with debounce" } as AgentMessage],
      },
      { sessionKey: "agent:mozi:telegram:dm:chat-1", agentId: "mozi" },
    );

    const date = new Date().toISOString().split("T")[0];
    const dailyPath = path.join(homeDir, "memory", "daily", `${date}.md`);

    const recordsBefore: MemoryCandidate[] = await makeInboxStore(homeDir).readShard(date);
    const dailyExistsBefore = await fs.access(dailyPath).then(() => true).catch(() => false);

    expect(recordsBefore.length).toBeGreaterThan(0);
    expect(recordsBefore[0]?.status).toBe("pending");
    expect(dailyExistsBefore).toBe(false);

    await waitForMemoryFiles(path.join(homeDir, "memory", "daily"), 3000);

    const recordsAfter: MemoryCandidate[] = await makeInboxStore(homeDir).readShard(date);
    const dailyText = await fs.readFile(dailyPath, "utf8");

    expect(recordsAfter[0]?.status).toBe("accepted_daily");
    expect(dailyText).toContain("# Daily Memory");
    expect(dailyText).toContain("decision with debounce");
  });

  it("rebuilds MEMORY.md after before_reset long-term promotion", async () => {
    configureMemoryMaintainerHooks(createConfig(tempDir, homeDir));
    const runner = getRuntimeHookRunner();

    await runner.runBeforeReset(
      {
        reason: "new",
        messages: [{ role: "user", content: "prefer dark mode" } as AgentMessage],
      },
      { sessionKey: "agent:mozi:telegram:dm:chat-1", agentId: "mozi" },
    );

    const date = new Date().toISOString().split("T")[0];
    const records: MemoryCandidate[] = await makeInboxStore(homeDir).readShard(date);
    const memoryText = await fs.readFile(path.join(homeDir, "MEMORY.md"), "utf8");

    expect(records[0]?.status).toBe("promoted");
    expect(memoryText).toContain("# Memory");
    expect(memoryText).toContain("## User Preferences");
    expect(memoryText).toContain("- prefer dark mode");
  });

  // -------------------------------------------------------------------------
  // Session snapshot (context-continuity, kept separate)
  // -------------------------------------------------------------------------

  it("writes session memory snapshot when hook is enabled", async () => {
    const cfg = createConfig(tempDir, homeDir);
    cfg.hooks = {
      sessionMemory: {
        llmSlug: false,
      },
    };
    configureMemoryMaintainerHooks(cfg);
    const runner = getRuntimeHookRunner();

    const messages: AgentMessage[] = [
      { role: "user", content: "We decided to ship feature A" } as AgentMessage,
      { role: "assistant", content: "Captured the decision for release notes" } as unknown as AgentMessage,
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

    const memoryDir = path.join(cfg.agents?.mozi?.workspace ?? "", "memory");
    const files = await waitForMemoryFiles(memoryDir);
    expect(files.length).toBe(1);
    const content = await fs.readFile(path.join(memoryDir, files[0] ?? ""), "utf-8");
    expect(content).toContain("Session Key");
    expect(content).toContain("user: We decided to ship feature A");
    expect(content).toContain("assistant: Captured the decision for release notes");
  });

  it("session snapshot does not appear in inbox", async () => {
    const cfg = createConfig(tempDir, homeDir);
    cfg.hooks = { sessionMemory: { llmSlug: false } };
    configureMemoryMaintainerHooks(cfg);
    const runner = getRuntimeHookRunner();

    const messages: AgentMessage[] = [
      { role: "user", content: "snapshot test message" } as AgentMessage,
    ];

    await runner.runBeforeReset(
      { reason: "new", messages },
      { sessionKey: "agent:mozi:telegram:dm:chat-1", agentId: "mozi" },
    );

    // The snapshot file is in workspace/memory – NOT in the inbox
    const date4 = new Date().toISOString().split("T")[0];
    const inboxRecords: MemoryCandidate[] = await makeInboxStore(homeDir).readShard(date4);

    // The inbox candidate comes from before_reset extraction – verify it is
    // a structured candidate (has id, source fields), not a raw snapshot.
    for (const r of inboxRecords) {
      expect(r.id).toBeDefined();
      expect(r.source).toBe("before_reset");
    }
  });

  // -------------------------------------------------------------------------
  // Robustness
  // -------------------------------------------------------------------------

  it("ignores turn events with status=interrupted", async () => {
    configureMemoryMaintainerHooks(createConfig(tempDir, homeDir));
    const runner = getRuntimeHookRunner();

    for (let i = 1; i <= 3; i += 1) {
      await runner.runTurnCompleted(
        {
          traceId: `turn-${i}`,
          messageId: `m-${i}`,
          status: "interrupted",
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

    const date5 = new Date().toISOString().split("T")[0];
    const records: MemoryCandidate[] = await makeInboxStore(homeDir).readShard(date5);
    expect(records.length).toBe(0);
  });

  it("no-ops gracefully when sessionKey or agentId is missing", async () => {
    configureMemoryMaintainerHooks(createConfig(tempDir, homeDir));
    const runner = getRuntimeHookRunner();

    // Should not throw
    await runner.runTurnCompleted(
      {
        traceId: "t1",
        messageId: "m1",
        status: "success",
        durationMs: 10,
        userText: "hello",
      },
      {}, // no sessionKey, no agentId
    );

    await runner.runBeforeReset({ reason: "new" }, {});
  });
});

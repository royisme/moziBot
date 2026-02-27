/**
 * Tests for tape anchor dual-write in compactSession (TAPE-2).
 *
 * Verifies that:
 * 1. A tape anchor is created alongside destructive compaction.
 * 2. The anchor carries the compaction summary.
 * 3. buildMessagesFromTape returns only post-anchor entries.
 * 4. Multiple compactions create multiple anchors.
 * 5. When getTapeService returns null, compaction still works (backward compat).
 * 6. When getTapeService is omitted entirely, compaction still works (backward compat).
 */

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStore } from "../session-store";
import { compactSession } from "./context-metrics";
import { TapeStore } from "../../tape/tape-store.js";
import { TapeService } from "../../tape/tape-service.js";
import { buildMessagesFromTape, createTapeService } from "../../tape/integration.js";

// ---- Mock hooks so they don't interfere ----
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runBeforeCompaction: vi.fn(async () => {}),
    runAfterCompaction: vi.fn(async () => {}),
  },
}));

vi.mock("../hooks", () => ({
  getRuntimeHookRunner: () => hookMocks.runner,
}));

// ---- Helpers ----

function makeTempStore(): { store: TapeStore; service: TapeService } {
  const tempDir = mkdtempSync(join(tmpdir(), "tape-compaction-test-"));
  const store = new TapeStore(tempDir, "/test/workspace");
  const service = createTapeService(store, "session:test-key");
  return { store, service };
}

function makeAgent(messageCount = 4, summary = "Compacted summary"): AgentSession {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message-${i}`,
  }));
  return {
    messages,
    compact: vi.fn(async () => ({ tokensBefore: 500, summary })),
  } as unknown as AgentSession;
}

function makeSessions(): SessionStore {
  return {
    get: vi.fn(() => ({ agentId: "mozi", latestSessionFile: "/tmp/session.jsonl" })),
    update: vi.fn(),
  } as unknown as SessionStore;
}

// ---- Tests ----

describe("compactSession tape anchor dual-write (TAPE-2)", () => {
  const sessionKey = "session:test-key";

  beforeEach(() => {
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runBeforeCompaction.mockClear();
    hookMocks.runner.runAfterCompaction.mockClear();
  });

  it("creates a tape anchor after successful compaction", async () => {
    const { service } = makeTempStore();
    const agent = makeAgent(4, "Test summary text");
    const sessions = makeSessions();

    const result = await compactSession({
      sessionKey,
      agents: new Map([[sessionKey, agent]]),
      sessions,
      getTapeService: () => service,
    });

    expect(result.success).toBe(true);

    const anchors = service.anchors();
    // bootstrap anchor ('session/start') + auto-compact anchor
    expect(anchors).toHaveLength(2);
    expect(anchors[anchors.length - 1].name).toBe("auto-compact");
  });

  it("stores the compaction summary in the tape anchor", async () => {
    const summaryText = "Decisions made: chose TypeScript. Open TODO: write tests.";
    const { service } = makeTempStore();
    const agent = makeAgent(4, summaryText);
    const sessions = makeSessions();

    await compactSession({
      sessionKey,
      agents: new Map([[sessionKey, agent]]),
      sessions,
      getTapeService: () => service,
    });

    const anchors = service.anchors();
    const compactAnchor = anchors.find((a) => a.name === "auto-compact");
    expect(compactAnchor).toBeDefined();
    expect(compactAnchor!.state.summary).toBe(summaryText);
  });

  it("buildMessagesFromTape returns only post-anchor entries", async () => {
    const { service } = makeTempStore();

    // Record two turns before compaction
    service.appendMessage("user", "pre-compact message 1");
    service.appendMessage("assistant", "pre-compact response 1");

    const agent = makeAgent(4, "Summary of old messages");
    const sessions = makeSessions();

    await compactSession({
      sessionKey,
      agents: new Map([[sessionKey, agent]]),
      sessions,
      getTapeService: () => service,
    });

    // Record a turn after compaction
    service.appendMessage("user", "post-compact message");
    service.appendMessage("assistant", "post-compact response");

    const messages = buildMessagesFromTape(service);

    // Only the post-anchor entries should be visible
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("post-compact message");
    expect(messages[1].content).toBe("post-compact response");
  });

  it("multiple compactions create multiple anchors", async () => {
    const { service } = makeTempStore();
    const sessions = makeSessions();

    // First compaction
    const agent1 = makeAgent(4, "First summary");
    await compactSession({
      sessionKey,
      agents: new Map([[sessionKey, agent1]]),
      sessions,
      getTapeService: () => service,
    });

    // Second compaction
    const agent2 = makeAgent(4, "Second summary");
    await compactSession({
      sessionKey,
      agents: new Map([[sessionKey, agent2]]),
      sessions,
      getTapeService: () => service,
    });

    const anchors = service.anchors();
    // bootstrap + first compact + second compact = 3
    expect(anchors).toHaveLength(3);

    const compactAnchors = anchors.filter((a) => a.name === "auto-compact");
    expect(compactAnchors).toHaveLength(2);
    expect(compactAnchors[0].state.summary).toBe("First summary");
    expect(compactAnchors[1].state.summary).toBe("Second summary");
  });

  it("works correctly when getTapeService returns null (backward compat)", async () => {
    const agent = makeAgent(4);
    const sessions = makeSessions();

    const result = await compactSession({
      sessionKey,
      agents: new Map([[sessionKey, agent]]),
      sessions,
      getTapeService: () => null,
    });

    expect(result.success).toBe(true);
    expect(result.tokensReclaimed).toBe(500);
  });

  it("works correctly when getTapeService is omitted (backward compat)", async () => {
    const agent = makeAgent(4);
    const sessions = makeSessions();

    const result = await compactSession({
      sessionKey,
      agents: new Map([[sessionKey, agent]]),
      sessions,
      // No getTapeService provided — old call signature
    });

    expect(result.success).toBe(true);
    expect(result.tokensReclaimed).toBe(500);
  });

  it("tape errors are non-fatal — compaction still succeeds", async () => {
    const agent = makeAgent(4);
    const sessions = makeSessions();

    const result = await compactSession({
      sessionKey,
      agents: new Map([[sessionKey, agent]]),
      sessions,
      getTapeService: () => {
        // Return a tape service whose handoff method throws
        return {
          handoff: () => {
            throw new Error("Tape I/O error");
          },
          info: () => ({ name: "test", entries: 0, anchors: 0, lastAnchor: null, entriesSinceLastAnchor: 0 }),
        } as unknown as TapeService;
      },
    });

    // Compaction must still succeed despite the tape error
    expect(result.success).toBe(true);
    expect(result.tokensReclaimed).toBe(500);
  });

  it("does not create anchor when agent.compact() rejects", async () => {
    const { service } = makeTempStore();
    const sessions = makeSessions();

    const failingAgent = {
      messages: [{ role: "user", content: "a" }, {}, {}, {}],
      compact: vi.fn(async () => {
        throw new Error("compact failed");
      }),
    } as unknown as AgentSession;

    const result = await compactSession({
      sessionKey,
      agents: new Map([[sessionKey, failingAgent]]),
      sessions,
      getTapeService: () => service,
    });

    expect(result.success).toBe(false);
    // Only the bootstrap anchor should exist — no auto-compact anchor
    const anchors = service.anchors();
    const compactAnchors = anchors.filter((a) => a.name === "auto-compact");
    expect(compactAnchors).toHaveLength(0);
  });
});

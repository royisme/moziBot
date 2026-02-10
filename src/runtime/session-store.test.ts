import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MoziConfig } from "../config";
import { SessionStore } from "./session-store";

describe("SessionStore segmented lifecycle", () => {
  let baseDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-session-store-"));
    sessionsDir = path.join(baseDir, "sessions");
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  function createConfig(): MoziConfig {
    return {
      paths: {
        baseDir,
        sessions: sessionsDir,
      },
    };
  }

  it("session_new_hard_cut_creates_segment", () => {
    const store = new SessionStore(createConfig());
    const sessionKey = "agent:mozi:telegram:dm:user1";
    const first = store.getOrCreate(sessionKey, "mozi");
    const firstId = first.latestSessionId;

    const rotated = store.rotateSegment(sessionKey, "mozi");

    expect(rotated.latestSessionId).toBeTruthy();
    expect(rotated.latestSessionId).not.toBe(firstId);
    expect(rotated.sessionId).toBe(rotated.latestSessionId);
    expect(rotated.context).toEqual([]);
    expect(rotated.historySessionIds).toContain(firstId);
    if (!firstId || !rotated.segments) {
      return;
    }
    expect(rotated.segments[firstId]?.archived).toBe(true);
    expect(rotated.segments[rotated.latestSessionId || ""]?.prevSessionId).toBe(firstId);
  });

  it("session_new_repeated_chain_integrity", () => {
    const store = new SessionStore(createConfig());
    const sessionKey = "agent:mozi:telegram:dm:user2";
    const s1 = store.getOrCreate(sessionKey, "mozi");
    const id1 = s1.latestSessionId;

    const s2 = store.rotateSegment(sessionKey, "mozi");
    const id2 = s2.latestSessionId;
    const s3 = store.rotateSegment(sessionKey, "mozi");
    const id3 = s3.latestSessionId;

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id3).toBeTruthy();
    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);

    const finalState = store.get(sessionKey);
    expect(finalState?.latestSessionId).toBe(id3);
    expect(finalState?.historySessionIds).toContain(id1);
    expect(finalState?.historySessionIds).toContain(id2);

    if (!id1 || !id2 || !id3 || !finalState?.segments) {
      return;
    }
    expect(finalState.segments[id1]?.nextSessionId).toBe(id2);
    expect(finalState.segments[id2]?.prevSessionId).toBe(id1);
    expect(finalState.segments[id2]?.nextSessionId).toBe(id3);
    expect(finalState.segments[id3]?.prevSessionId).toBe(id2);
    expect(finalState.segments[id1]?.archived).toBe(true);
    expect(finalState.segments[id2]?.archived).toBe(true);
    expect(finalState.segments[id3]?.archived).toBe(false);
  });

  it("latest_context_uses_latest_only", () => {
    const store = new SessionStore(createConfig());
    const sessionKey = "agent:mozi:telegram:dm:user3";

    const first = store.getOrCreate(sessionKey, "mozi");
    store.update(sessionKey, { context: [{ role: "user", content: "segment-1" }] });
    const firstId = first.latestSessionId;

    const rotated = store.rotateSegment(sessionKey, "mozi");
    store.update(sessionKey, { context: [{ role: "user", content: "segment-2" }] });

    const latest = store.getOrCreate(sessionKey, "mozi");
    expect(latest.latestSessionId).toBe(rotated.latestSessionId);
    expect(latest.context).toEqual([{ role: "user", content: "segment-2" }]);
    expect(latest.historySessionIds).toContain(firstId);
  });

  it("history_segment_immutable", () => {
    const store = new SessionStore(createConfig());
    const sessionKey = "agent:mozi:telegram:dm:user4";

    const first = store.getOrCreate(sessionKey, "mozi");
    const firstId = first.latestSessionId;
    if (!firstId) {
      throw new Error("expected initial segment id");
    }

    store.rotateSegment(sessionKey, "mozi");
    const stateAfterRotate = store.getOrCreate(sessionKey, "mozi");
    const archivedBefore = stateAfterRotate.segments?.[firstId];
    const archivedBeforeUpdatedAt = archivedBefore?.updatedAt;

    store.update(sessionKey, {
      segments: {
        [firstId]: {
          sessionId: firstId,
          sessionFile: archivedBefore?.sessionFile || "",
          createdAt: archivedBefore?.createdAt || 0,
          updatedAt: Date.now() + 60_000,
          archived: false,
          summary: "mutated-summary-should-not-apply",
        },
      },
    });

    const stateAfterMutation = store.getOrCreate(sessionKey, "mozi");
    const archivedAfter = stateAfterMutation.segments?.[firstId];
    expect(archivedAfter?.archived).toBe(true);
    expect(archivedAfter?.summary).not.toBe("mutated-summary-should-not-apply");
    expect(archivedAfter?.updatedAt).toBe(archivedBeforeUpdatedAt);
  });

  it("semantic_rollover_reversible", () => {
    const store = new SessionStore(createConfig());
    const sessionKey = "agent:mozi:telegram:dm:user5";

    store.getOrCreate(sessionKey, "mozi");
    store.update(sessionKey, { context: [{ role: "user", content: "before-rotation" }] });
    const rotated = store.rotateSegment(sessionKey, "mozi");
    const rotatedId = rotated.latestSessionId;
    store.update(sessionKey, { context: [{ role: "user", content: "after-rotation" }] });

    const reverted = store.revertToPreviousSegment(sessionKey, "mozi");
    expect(reverted).toBeDefined();
    if (!reverted || !rotatedId) {
      return;
    }

    expect(reverted.latestSessionId).not.toBe(rotatedId);
    expect(reverted.context).toEqual([
      { role: "user", content: "before-rotation" },
      { role: "user", content: "after-rotation" },
    ]);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryInboxStore } from "./inbox-store";
import { GovernanceMaintenanceRunner } from "./maintenance-runner";
import { buildCandidate } from "./normalization";
import type { MemoryCandidate, MemoryCandidateCategory } from "./types";

function makeCandidate(params: {
  category: MemoryCandidateCategory;
  summary: string;
  ts?: string;
  evidence?: MemoryCandidate["evidence"];
  scopeHint?: MemoryCandidate["scopeHint"];
  promoteCandidate?: boolean;
}): MemoryCandidate {
  return buildCandidate({
    ts: params.ts ?? "2024-03-15T10:00:00Z",
    agentId: "mozi",
    source: "turn_completed",
    category: params.category,
    summary: params.summary,
    evidence: params.evidence ?? ["system_observed"],
    confidence: 0.9,
    stability: "high",
    scopeHint:
      params.scopeHint ?? (params.category === "preference" ? "long_term_candidate" : "daily"),
    promoteCandidate: params.promoteCandidate ?? params.category === "preference",
    status: "pending",
  });
}

describe("GovernanceMaintenanceRunner", () => {
  let tempDir = "";
  let homeDir = "";
  let memoryDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-governance-runner-"));
    homeDir = path.join(tempDir, "home");
    memoryDir = path.join(homeDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts daily candidates and rewrites the daily markdown shard", async () => {
    const inbox = new MemoryInboxStore(memoryDir);
    const candidate = makeCandidate({ category: "lesson", summary: "document deployment lessons" });
    await inbox.append(candidate);

    const runner = new GovernanceMaintenanceRunner(homeDir);
    const result = await runner.runForDate("2024-03-15");
    const updated = await inbox.readShard("2024-03-15");
    const dailyText = await fs.readFile(path.join(memoryDir, "daily", "2024-03-15.md"), "utf8");

    expect(result.acceptedDaily).toBe(1);
    expect(result.promoted).toBe(0);
    expect(updated[0]?.status).toBe("accepted_daily");
    expect(dailyText).toContain("# Daily Memory 2024-03-15");
    expect(dailyText).toContain("## Lessons");
    expect(dailyText).toContain("- document deployment lessons");
  });

  it("promotes long-term candidates and rebuilds MEMORY.md", async () => {
    const inbox = new MemoryInboxStore(memoryDir);
    const candidate = makeCandidate({
      category: "preference",
      summary: "prefer dark mode",
      evidence: ["user_explicit"],
      scopeHint: "long_term_candidate",
      promoteCandidate: true,
    });
    await inbox.append(candidate);

    const runner = new GovernanceMaintenanceRunner(homeDir);
    const result = await runner.runForDate("2024-03-15");
    const updated = await inbox.readShard("2024-03-15");
    const memoryText = await fs.readFile(path.join(homeDir, "MEMORY.md"), "utf8");

    expect(result.promoted).toBe(1);
    expect(result.memoryPath).toBe(path.join(homeDir, "MEMORY.md"));
    expect(updated[0]?.status).toBe("promoted");
    expect(memoryText).toContain("# Memory");
    expect(memoryText).toContain("## User Preferences");
    expect(memoryText).toContain("- prefer dark mode");
  });
});

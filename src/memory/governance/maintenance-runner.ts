import { join } from "node:path";
import { DailyMemoryCompiler } from "./daily-compiler";
import { atomicWrite } from "./file-store-utils";
import { MemoryInboxStore } from "./inbox-store";
import { LongTermStore } from "./longterm-store";
import { LongTermMemoryWriter } from "./longterm-writer";
import { MemoryPolicyEngine } from "./policy-engine";
import type { MemoryCandidate } from "./types";

function toUtcDateString(ts: string): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface GovernanceMaintenanceResult {
  date: string;
  evaluated: number;
  rejected: number;
  acceptedDaily: number;
  promoted: number;
  dailyPath: string;
  memoryPath?: string;
}

export class GovernanceMaintenanceRunner {
  private readonly inbox: MemoryInboxStore;
  private readonly policy: MemoryPolicyEngine;
  private readonly dailyCompiler: DailyMemoryCompiler;
  private readonly longTermStore: LongTermStore;
  private readonly longTermWriter: LongTermMemoryWriter;

  constructor(private readonly homeDir: string) {
    const memoryDir = join(homeDir, "memory");
    this.inbox = new MemoryInboxStore(memoryDir);
    this.policy = new MemoryPolicyEngine();
    this.dailyCompiler = new DailyMemoryCompiler();
    this.longTermStore = new LongTermStore(memoryDir);
    this.longTermWriter = new LongTermMemoryWriter(homeDir);
  }

  async runForDate(date: string): Promise<GovernanceMaintenanceResult> {
    const shard = await this.inbox.readShard(date);
    const pending = shard.filter((candidate) => candidate.status === "pending");

    let rejected = 0;
    let acceptedDaily = 0;
    let promoted = 0;
    let longTermChanged = false;

    for (const candidate of pending) {
      const result = this.policy.evaluate(candidate);
      if (result.verdict === "reject") {
        await this.inbox.updateStatus(
          candidate.id,
          candidate.ts,
          "rejected",
          result.rejectionReason,
        );
        rejected += 1;
        continue;
      }
      if (result.verdict === "promote") {
        const appended = await this.longTermStore.appendFromCandidate(candidate);
        await this.inbox.updateStatus(candidate.id, candidate.ts, "promoted");
        promoted += 1;
        if (appended) {
          longTermChanged = true;
        }
        continue;
      }
      await this.inbox.updateStatus(candidate.id, candidate.ts, "accepted_daily");
      acceptedDaily += 1;
    }

    const refreshed = await this.inbox.readShard(date);
    const compilation = this.dailyCompiler.compile({ date, candidates: refreshed });
    const dailyPath = join(this.homeDir, "memory", "daily", `${date}.md`);
    await atomicWrite(dailyPath, compilation.markdown);

    let memoryPath: string | undefined;
    if (longTermChanged) {
      memoryPath = await this.longTermWriter.rebuild(await this.longTermStore.readAll());
    }

    return {
      date,
      evaluated: pending.length,
      rejected,
      acceptedDaily,
      promoted,
      dailyPath,
      memoryPath,
    };
  }

  async runForCandidate(candidate: MemoryCandidate): Promise<GovernanceMaintenanceResult> {
    return this.runForDate(toUtcDateString(candidate.ts));
  }
}

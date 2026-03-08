import fs from "node:fs";
import path from "node:path";
import { logger } from "../../../logger";
import { announceSubagentResult } from "./subagent-announce";

export type SubAgentRunStatus =
  | "accepted"
  | "started"
  | "streaming"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

export interface SubAgentRunRecord {
  runId: string;
  childKey: string;
  parentKey: string;
  task: string;
  label?: string;
  cleanup: "delete" | "keep";
  status: SubAgentRunStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  error?: string;
  announced?: boolean;
  timeoutSeconds?: number;
}

export class EnhancedSubAgentRegistry {
  private runs: Map<string, SubAgentRunRecord> = new Map();
  private persistPath: string;
  private sweepInterval: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.persistPath = path.join(dataDir, "subagent-runs.json");
    this.restore();
    this.startSweeper();
  }

  register(
    run: Omit<SubAgentRunRecord, "createdAt" | "status"> & {
      createdAt?: number;
      status?: SubAgentRunStatus;
    },
  ): void {
    const record: SubAgentRunRecord = {
      ...run,
      createdAt: run.createdAt ?? Date.now(),
      status: run.status ?? "accepted",
    };
    this.runs.set(record.runId, record);
    this.persist();
  }

  get(runId: string): SubAgentRunRecord | undefined {
    return this.runs.get(runId);
  }

  getByChildKey(childKey: string): SubAgentRunRecord | undefined {
    return [...this.runs.values()].find((r) => r.childKey === childKey);
  }

  listByParent(parentKey: string): SubAgentRunRecord[] {
    return [...this.runs.values()]
      .filter((r) => r.parentKey === parentKey)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  listAll(): SubAgentRunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  listActiveByParent(parentKey: string): SubAgentRunRecord[] {
    return this.listByParent(parentKey).filter(
      (r) => !["completed", "failed", "aborted", "timeout"].includes(r.status),
    );
  }

  update(runId: string, changes: Partial<SubAgentRunRecord>): SubAgentRunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    Object.assign(run, changes);
    this.persist();
    return run;
  }

  markStarted(runId: string, startedAt = Date.now()): SubAgentRunRecord | undefined {
    return this.update(runId, { status: "started", startedAt });
  }

  markStreaming(runId: string, startedAt?: number): SubAgentRunRecord | undefined {
    return this.update(runId, {
      status: "streaming",
      ...(startedAt ? { startedAt } : {}),
    });
  }

  async setTerminal(params: {
    runId: string;
    status: "completed" | "failed" | "aborted" | "timeout";
    result?: string;
    error?: string;
    endedAt?: number;
  }): Promise<SubAgentRunRecord | undefined> {
    const run = this.runs.get(params.runId);
    if (!run) {
      return undefined;
    }
    if (run.announced || ["completed", "failed", "aborted", "timeout"].includes(run.status)) {
      return run;
    }

    run.status = params.status;
    run.result = params.result;
    run.error = params.error;
    run.endedAt = params.endedAt ?? Date.now();
    this.persist();

    await this.triggerAnnounce(run);
    return run;
  }

  async completeByChildKey(
    childKey: string,
    result: {
      status: "completed" | "failed" | "aborted" | "timeout";
      result?: string;
      error?: string;
    },
  ): Promise<void> {
    const run = this.getByChildKey(childKey);
    if (!run) {
      return;
    }
    await this.setTerminal({ runId: run.runId, ...result });
  }

  private async triggerAnnounce(run: SubAgentRunRecord): Promise<void> {
    if (run.announced) {
      return;
    }

    if (!["completed", "failed", "timeout", "aborted"].includes(run.status)) {
      return;
    }

    const shouldAnnounce = run.status !== "aborted";
    if (shouldAnnounce) {
      try {
        const announced = await announceSubagentResult({
          runId: run.runId,
          childKey: run.childKey,
          parentKey: run.parentKey,
          task: run.task,
          label: run.label,
          status:
            run.status === "completed"
              ? "completed"
              : run.status === "timeout"
                ? "timeout"
                : "failed",
          result: run.result,
          error: run.error,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
        });
        if (!announced) {
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message, runId: run.runId }, "Failed to announce subagent result");
        return;
      }
    }

    run.announced = true;
    this.persist();

    if (run.cleanup === "delete") {
      this.runs.delete(run.runId);
      this.persist();
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const data = Object.fromEntries(this.runs);
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, "Failed to persist subagent registry");
    }
  }

  private restore(): void {
    try {
      if (!fs.existsSync(this.persistPath)) {
        return;
      }
      const data = JSON.parse(fs.readFileSync(this.persistPath, "utf-8"));
      for (const [id, record] of Object.entries(data)) {
        this.runs.set(id, record as SubAgentRunRecord);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, "Failed to restore subagent registry");
    }
  }

  private startSweeper(): void {
    const sweepMs = 5 * 60 * 1000;
    this.sweepInterval = setInterval(() => {
      const cutoff = Date.now() - 60 * 60 * 1000;
      let swept = 0;
      for (const [id, run] of this.runs) {
        if (run.announced && run.endedAt && run.endedAt < cutoff) {
          this.runs.delete(id);
          swept += 1;
        }
      }
      if (swept > 0) {
        this.persist();
      }
    }, sweepMs);
    this.sweepInterval.unref?.();
  }

  async reconcileOrphanedRuns(): Promise<void> {
    const orphanedRuns = [...this.runs.values()].filter(
      (run) => !run.announced && ["accepted", "started", "streaming"].includes(run.status),
    );

    for (const run of orphanedRuns) {
      logger.warn(
        { runId: run.runId, childKey: run.childKey, status: run.status },
        "Marking orphaned subagent run as failed after host restart",
      );
      await this.setTerminal({
        runId: run.runId,
        status: "failed",
        error: "Host restarted while run was in progress",
      });
    }
  }

  shutdown(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    this.persist();
  }
}

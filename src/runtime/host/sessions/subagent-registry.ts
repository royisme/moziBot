import fs from "node:fs";
import path from "node:path";
import { onAgentEvent, type AgentEvent } from "../../../infra/agent-events";
import { logger } from "../../../logger";
import { announceSubagentResult } from "./subagent-announce";

export interface SubAgentRunRecord {
  runId: string;
  childKey: string;
  parentKey: string;
  task: string;
  label?: string;
  cleanup: "delete" | "keep";
  status: "pending" | "running" | "completed" | "failed" | "timeout";
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  error?: string;
  announced?: boolean;
}

export class EnhancedSubAgentRegistry {
  private runs: Map<string, SubAgentRunRecord> = new Map();
  private listenerStop: (() => void) | null = null;
  private persistPath: string;
  private sweepInterval: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.persistPath = path.join(dataDir, "subagent-runs.json");
    this.restore();
    this.startListener();
    this.startSweeper();
  }

  register(run: Omit<SubAgentRunRecord, "createdAt" | "status">): void {
    const record: SubAgentRunRecord = {
      ...run,
      status: "pending",
      createdAt: Date.now(),
    };
    this.runs.set(run.runId, record);
    this.persist();
    logger.debug(`SubAgent registered: ${run.runId} for parent: ${run.parentKey}`);
  }

  get(runId: string): SubAgentRunRecord | undefined {
    return this.runs.get(runId);
  }

  getByChildKey(childKey: string): SubAgentRunRecord | undefined {
    return [...this.runs.values()].find((r) => r.childKey === childKey);
  }

  listByParent(parentKey: string): SubAgentRunRecord[] {
    return [...this.runs.values()].filter((r) => r.parentKey === parentKey);
  }

  listAll(): SubAgentRunRecord[] {
    return [...this.runs.values()];
  }

  private startListener(): void {
    this.listenerStop = onAgentEvent((evt) => this.handleEvent(evt));
  }

  private handleEvent(evt: AgentEvent): void {
    if (evt.stream !== "lifecycle") {
      return;
    }

    const run = this.getByChildKey(evt.sessionKey);
    if (!run) {
      return;
    }

    const { phase, startedAt, endedAt, error } = evt.data;

    if (phase === "start") {
      run.status = "running";
      run.startedAt = startedAt ?? Date.now();
      this.persist();
      logger.debug(`SubAgent started: ${run.runId}`);
      return;
    }

    if (phase === "end" || phase === "error") {
      run.endedAt = endedAt ?? Date.now();
      run.status = phase === "error" ? "failed" : "completed";
      if (error) {
        run.error = error;
      }
      this.persist();

      logger.debug(`SubAgent ${run.status}: ${run.runId}`);

      void this.triggerAnnounce(run);
    }
  }

  private async triggerAnnounce(run: SubAgentRunRecord): Promise<void> {
    if (run.announced) {
      return;
    }

    if (run.status !== "completed" && run.status !== "failed" && run.status !== "timeout") {
      return;
    }

    try {
      await announceSubagentResult({
        runId: run.runId,
        childKey: run.childKey,
        parentKey: run.parentKey,
        task: run.task,
        label: run.label,
        status: run.status,
        result: run.result,
        error: run.error,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      });

      run.announced = true;
      this.persist();

      if (run.cleanup === "delete") {
        this.runs.delete(run.runId);
        this.persist();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, runId: run.runId }, "Failed to announce subagent result");
    }
  }

  private persist(): void {
    try {
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
      logger.info({ count: this.runs.size }, "Restored subagent runs from disk");
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
          swept++;
        }
      }
      if (swept > 0) {
        this.persist();
        logger.debug(`Swept ${swept} old subagent runs`);
      }
    }, sweepMs);
    this.sweepInterval.unref?.();
  }

  shutdown(): void {
    if (this.listenerStop) {
      this.listenerStop();
      this.listenerStop = null;
    }
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    this.persist();
  }
}

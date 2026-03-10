import fs from "node:fs";
import path from "node:path";
import { logger } from "../../../logger";
import { RUN_TERMINAL_STATES } from "../message-handler/services/run-lifecycle-registry";
import { announceDetachedRunResult } from "./subagent-announce";

export type DetachedRunStatus =
  | "accepted"
  | "started"
  | "streaming"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

export interface DetachedRunRecord {
  runId: string;
  kind: "subagent" | "acp";
  childKey: string;
  parentKey: string;
  task: string;
  label?: string;
  cleanup: "delete" | "keep";
  status: DetachedRunStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  error?: string;
  announced?: boolean;
  timeoutSeconds?: number;
}

export class DetachedRunRegistry {
  private runs: Map<string, DetachedRunRecord> = new Map();
  private persistPath: string;
  private sweepInterval: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.persistPath = path.join(dataDir, "subagent-runs.json");
    this.restore();
    this.startSweeper();
  }

  register(
    run: Omit<DetachedRunRecord, "createdAt" | "status" | "kind"> & {
      kind?: "subagent" | "acp";
      createdAt?: number;
      status?: DetachedRunStatus;
    },
  ): void {
    const record: DetachedRunRecord = {
      ...run,
      kind: run.kind ?? "subagent",
      createdAt: run.createdAt ?? Date.now(),
      status: run.status ?? "accepted",
    };
    this.runs.set(record.runId, record);
    this.persist();
  }

  get(runId: string): DetachedRunRecord | undefined {
    return this.runs.get(runId);
  }

  getByChildKey(childKey: string): DetachedRunRecord | undefined {
    return [...this.runs.values()].find((r) => r.childKey === childKey);
  }

  listByParent(parentKey: string): DetachedRunRecord[] {
    return [...this.runs.values()]
      .filter((r) => r.parentKey === parentKey)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  listAll(): DetachedRunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  listActiveByParent(parentKey: string): DetachedRunRecord[] {
    return this.listByParent(parentKey).filter(
      (r) => !["completed", "failed", "aborted", "timeout"].includes(r.status),
    );
  }

  update(runId: string, changes: Partial<DetachedRunRecord>): DetachedRunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    Object.assign(run, changes);
    this.persist();
    return run;
  }

  markStarted(runId: string, startedAt = Date.now()): DetachedRunRecord | undefined {
    return this.update(runId, { status: "started", startedAt });
  }

  markStreaming(runId: string, startedAt?: number): DetachedRunRecord | undefined {
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
  }): Promise<DetachedRunRecord | undefined> {
    const run = this.runs.get(params.runId);
    if (!run) {
      return undefined;
    }
    if (run.announced || RUN_TERMINAL_STATES.includes(run.status as (typeof RUN_TERMINAL_STATES)[number])) {
      return run;
    }

    const previous = { ...run };
    run.status = params.status;
    run.result = params.result;
    run.error = params.error;
    run.endedAt = params.endedAt ?? Date.now();
    try {
      this.persist();
    } catch (error) {
      Object.assign(run, previous);
      throw error;
    }

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

  private async triggerAnnounce(run: DetachedRunRecord): Promise<void> {
    if (run.announced) {
      return;
    }

    if (!RUN_TERMINAL_STATES.includes(run.status as (typeof RUN_TERMINAL_STATES)[number])) {
      return;
    }

    const status =
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "timeout" ||
      run.status === "aborted"
        ? run.status
        : undefined;
    if (!status) {
      return;
    }

    try {
      const announced = await announceDetachedRunResult({
        runId: run.runId,
        childKey: run.childKey,
        parentKey: run.parentKey,
        task: run.task,
        label: run.label,
        kind: run.kind,
        status,
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
      logger.error({ err: message, runId: run.runId }, "Failed to announce detached run result");
      return;
    }

    run.announced = true;
    this.persist();

    if (run.cleanup === "delete") {
      this.runs.delete(run.runId);
      this.persist();
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
    const data = Object.fromEntries(this.runs);
    fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
  }

  private restore(): void {
    try {
      if (!fs.existsSync(this.persistPath)) {
        return;
      }
      const data = JSON.parse(fs.readFileSync(this.persistPath, "utf-8"));
      for (const [id, record] of Object.entries(data)) {
        const restored = record as Partial<DetachedRunRecord>;
        this.runs.set(id, {
          ...restored,
          runId: restored.runId ?? id,
          kind: restored.kind ?? "subagent",
          childKey: restored.childKey ?? "",
          parentKey: restored.parentKey ?? "",
          task: restored.task ?? "",
          cleanup: restored.cleanup ?? "keep",
          status: restored.status ?? "accepted",
          createdAt: restored.createdAt ?? Date.now(),
        } as DetachedRunRecord);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, "Failed to restore detached run registry");
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
    const pendingAnnouncementRuns = [...this.runs.values()].filter(
      (run) => !run.announced && RUN_TERMINAL_STATES.includes(run.status as any),
    );

    for (const run of pendingAnnouncementRuns) {
      logger.warn(
        { runId: run.runId, childKey: run.childKey, kind: run.kind, status: run.status },
        "Retrying pending detached task completion announcement after host restart",
      );
      await this.triggerAnnounce(run);
    }

    const orphanedRuns = [...this.runs.values()].filter(
      (run) => !run.announced && !RUN_TERMINAL_STATES.includes(run.status as any),
    );

    for (const run of orphanedRuns) {
      logger.warn(
        { runId: run.runId, childKey: run.childKey, kind: run.kind, status: run.status },
        "Marking orphaned detached task run as failed after host restart",
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

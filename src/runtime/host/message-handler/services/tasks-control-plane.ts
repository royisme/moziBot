import type { DetachedRunRecord, DetachedRunRegistry } from "../../sessions/subagent-registry";
import { RUN_TERMINAL_STATES, type RunLifecycleRegistry } from "./run-lifecycle-registry";

export interface TaskRunView {
  runId: string;
  parentKey: string;
  childKey: string;
  label?: string;
  task: string;
  status: DetachedRunRecord["status"];
  runtimeState?: string;
  kind: DetachedRunRecord["kind"];
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  result?: string;
  abortRequestedAt?: number;
  abortRequestedBy?: string;
  staleDetectedAt?: number;
  live: boolean;
}

export interface StopTaskResult {
  ok: boolean;
  code: "stopped" | "already_terminal" | "not_found" | "forbidden";
  message: string;
  run?: TaskRunView;
}

export interface ReconcileTasksResult {
  ok: true;
  retried: number;
  reconciled: number;
  runIds: string[];
  message: string;
}

export interface CleanTasksResult {
  ok: true;
  cleaned: number;
  runIds: string[];
  message: string;
}

function toRunView(
  run: DetachedRunRecord,
  runLifecycleRegistry?: RunLifecycleRegistry,
): TaskRunView {
  const liveEntry = runLifecycleRegistry?.getRun(run.runId);
  return {
    runId: run.runId,
    parentKey: run.parentKey,
    childKey: run.childKey,
    label: run.label,
    task: run.task,
    status: run.status,
    runtimeState: liveEntry?.state,
    kind: run.kind,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    error: run.error,
    result: run.result,
    abortRequestedAt: run.abortRequestedAt,
    abortRequestedBy: run.abortRequestedBy,
    staleDetectedAt: run.staleDetectedAt,
    live: Boolean(liveEntry),
  };
}

export class TasksControlPlane {
  constructor(
    private readonly detachedRunRegistry: DetachedRunRegistry,
    private readonly runLifecycleRegistry?: RunLifecycleRegistry,
  ) {}

  listForParent(parentKey: string): TaskRunView[] {
    return this.detachedRunRegistry
      .listByParent(parentKey)
      .map((run) => toRunView(run, this.runLifecycleRegistry));
  }

  getDetail(runId: string, parentKey: string): TaskRunView | null {
    const run = this.detachedRunRegistry.get(runId);
    if (!run || run.parentKey !== parentKey) {
      return null;
    }
    return toRunView(run, this.runLifecycleRegistry);
  }

  async stop(runId: string, parentKey: string, requestedBy = "user"): Promise<StopTaskResult> {
    const run = this.detachedRunRegistry.get(runId);
    if (!run) {
      return { ok: false, code: "not_found", message: `Run not found: ${runId}` };
    }
    if (run.parentKey !== parentKey) {
      return {
        ok: false,
        code: "forbidden",
        message: `Run ${runId} does not belong to this session`,
      };
    }
    if (RUN_TERMINAL_STATES.includes(run.status as (typeof RUN_TERMINAL_STATES)[number])) {
      return {
        ok: true,
        code: "already_terminal",
        message: `Run ${runId} is already ${run.status}.`,
        run: toRunView(run, this.runLifecycleRegistry),
      };
    }

    this.detachedRunRegistry.markAbortRequested(runId, requestedBy);
    const aborted =
      this.runLifecycleRegistry?.abortRun(runId, `Stopped by ${requestedBy}`) ?? false;
    if (!aborted) {
      this.detachedRunRegistry.markStaleDetected(runId);
      await this.detachedRunRegistry.setTerminal({
        runId,
        status: "aborted",
        error: `Stopped by ${requestedBy} (orphaned run)`,
      });
    }

    const updated = this.detachedRunRegistry.get(runId);
    return {
      ok: true,
      code: "stopped",
      message: aborted
        ? `Stopped run ${runId}.`
        : `Stopped orphaned run ${runId} via terminal reconciliation.`,
      run: updated ? toRunView(updated, this.runLifecycleRegistry) : undefined,
    };
  }

  clean(parentKey: string): CleanTasksResult {
    const result = this.detachedRunRegistry.cleanTerminal(parentKey);
    return {
      ok: true,
      ...result,
      message:
        result.cleaned === 0
          ? "No terminal tasks to clean."
          : `Cleaned ${result.cleaned} terminal task(s).`,
    };
  }

  async reconcile(parentKey?: string, requestedBy = "reconciler"): Promise<ReconcileTasksResult> {
    const result = await this.detachedRunRegistry.reconcileOrphanedRuns({
      parentKey,
      requestedBy,
      isRunActive: (runId) => Boolean(this.runLifecycleRegistry?.getRun(runId)),
    });
    return {
      ok: true,
      ...result,
      message:
        result.retried === 0 && result.reconciled === 0
          ? "No detached runs required reconciliation."
          : `Reconciled ${result.reconciled} run(s) and retried ${result.retried} pending delivery run(s).`,
    };
  }
}

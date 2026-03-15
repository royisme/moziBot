import { RunBuffer } from "./run-buffer";

export type RunLifecycleState =
  | "accepted"
  | "started"
  | "streaming"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

export type RunTerminal = Extract<
  RunLifecycleState,
  "completed" | "failed" | "aborted" | "timeout"
>;

export const RUN_TERMINAL_STATES: RunTerminal[] = ["completed", "failed", "aborted", "timeout"];

export interface RunLifecycleEntry {
  readonly runId: string;
  readonly sessionKey: string;
  readonly queueItemId?: string;
  readonly agentId: string;
  readonly traceId?: string;
  readonly createdAt: number;
  readonly modelRef?: string;
  startedAt?: number;
  endedAt?: number;
  state: RunLifecycleState;
  readonly controller: AbortController;
  readonly buffer: RunBuffer;
  terminalError?: Error;
  terminalReason?: string;
}

type TerminalPayload = {
  readonly state: RunTerminal;
  readonly partialText?: string;
  readonly error?: Error;
  readonly reason?: string;
  readonly errorCode?: string;
};

type RunLifecycleListeners = {
  onAccepted?: (entry: RunLifecycleEntry) => void;
  onStarted?: (entry: RunLifecycleEntry) => void;
  onStreaming?: (entry: RunLifecycleEntry, delta: string) => void;
  onTerminal?: (entry: RunLifecycleEntry, payload: TerminalPayload) => void;
};

export class RunLifecycleRegistry {
  private readonly byRunId = new Map<string, RunLifecycleEntry>();
  private readonly runBySession = new Map<string, string>();

  listRuns(): RunLifecycleEntry[] {
    return [...this.byRunId.values()];
  }

  constructor(private readonly listeners: RunLifecycleListeners = {}) {}

  createRun(params: {
    runId: string;
    sessionKey: string;
    queueItemId?: string;
    agentId: string;
    traceId?: string;
    modelRef?: string;
    maxBufferChars?: number;
  }): RunLifecycleEntry {
    const existingRunId = this.runBySession.get(params.sessionKey);
    if (existingRunId) {
      this.abortRun(existingRunId, "superseded-by-new-run");
    }

    const entry: RunLifecycleEntry = {
      runId: params.runId,
      sessionKey: params.sessionKey,
      queueItemId: params.queueItemId,
      agentId: params.agentId,
      traceId: params.traceId,
      modelRef: params.modelRef,
      createdAt: Date.now(),
      state: "accepted",
      controller: new AbortController(),
      buffer: new RunBuffer(params.maxBufferChars),
    };

    this.byRunId.set(params.runId, entry);
    this.runBySession.set(params.sessionKey, params.runId);
    this.listeners.onAccepted?.(entry);
    return entry;
  }

  getRun(runId: string): RunLifecycleEntry | undefined {
    return this.byRunId.get(runId);
  }

  getRunBySession(sessionKey: string): RunLifecycleEntry | undefined {
    const runId = this.runBySession.get(sessionKey);
    if (!runId) {
      return undefined;
    }
    return this.byRunId.get(runId);
  }

  markStarted(runId: string): void {
    const entry = this.byRunId.get(runId);
    if (!entry || this.isTerminal(entry.state)) {
      return;
    }
    if (entry.state !== "started") {
      entry.state = "started";
      entry.startedAt = Date.now();
      this.listeners.onStarted?.(entry);
    }
  }

  appendDelta(runId: string, delta: string): void {
    const entry = this.byRunId.get(runId);
    if (!entry || this.isTerminal(entry.state)) {
      return;
    }
    entry.buffer.append(delta);
    if (entry.state !== "streaming") {
      entry.state = "streaming";
    }
    this.listeners.onStreaming?.(entry, delta);
  }

  setTerminal(runId: string, payload: TerminalPayload): boolean {
    const entry = this.byRunId.get(runId);
    if (!entry) {
      return false;
    }
    if (this.isTerminal(entry.state)) {
      return false;
    }

    entry.state = payload.state;
    entry.endedAt = Date.now();
    if (payload.partialText) {
      entry.buffer.replaceWith(payload.partialText);
    }
    entry.terminalError = payload.error;
    entry.terminalReason = payload.reason;

    if (
      (payload.state === "aborted" || payload.state === "timeout") &&
      !entry.controller.signal.aborted
    ) {
      entry.controller.abort(payload.reason ?? payload.error);
    }

    this.runBySession.delete(entry.sessionKey);

    this.listeners.onTerminal?.(entry, {
      ...payload,
      partialText: payload.partialText ?? entry.buffer.snapshot(),
    });

    return true;
  }

  abortRun(runId: string, reason = "manual-abort"): boolean {
    const entry = this.byRunId.get(runId);
    if (!entry) {
      return false;
    }
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(reason);
    }
    return this.setTerminal(runId, {
      state: "aborted",
      reason,
      partialText: entry.buffer.snapshot(),
    });
  }

  timeoutRun(runId: string, reason = "run-timeout"): boolean {
    const entry = this.byRunId.get(runId);
    if (!entry) {
      return false;
    }
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(reason);
    }
    return this.setTerminal(runId, {
      state: "timeout",
      reason,
      partialText: entry.buffer.snapshot(),
    });
  }

  abortSession(sessionKey: string, reason = "manual-abort"): boolean {
    const entry = this.getRunBySession(sessionKey);
    if (!entry) {
      return false;
    }
    return this.abortRun(entry.runId, reason);
  }

  finalizeCompleted(runId: string, finalText?: string): boolean {
    return this.setTerminal(runId, {
      state: "completed",
      partialText: finalText,
    });
  }

  finalizeFailed(runId: string, error: Error, reason?: string): boolean {
    const entry = this.byRunId.get(runId);
    return this.setTerminal(runId, {
      state: "failed",
      error,
      reason: reason ?? error.message,
      partialText: entry?.buffer.snapshot(),
    });
  }

  dispose(runId: string): void {
    const entry = this.byRunId.get(runId);
    if (!entry) {
      return;
    }
    this.byRunId.delete(runId);
    if (this.runBySession.get(entry.sessionKey) === runId) {
      this.runBySession.delete(entry.sessionKey);
    }
  }

  private isTerminal(state: RunLifecycleState): state is RunTerminal {
    return (
      state === "completed" || state === "failed" || state === "aborted" || state === "timeout"
    );
  }
}

import type { ProcessOutcome, ProcessHandle, ProcessOutputCallback, TerminationReason } from "./supervisor";

export type ManagedRunStatus = "running" | "exited" | "error";

export type ManagedRunOutcome = {
  status: ManagedRunStatus;
  exitCode?: number;
  signal?: string;
  error?: string;
  reason?: TerminationReason;
  timeoutSec?: number;
};

export class ManagedRun {
  private handle: ProcessHandle;
  private status: ManagedRunStatus = "running";
  private outcome: ManagedRunOutcome | null = null;
  private outputCallbacks: Set<ProcessOutputCallback> = new Set();
  private outputBuffer: string[] = [];
  private readonly maxBufferLength = 4096;

  constructor(handle: ProcessHandle) {
    this.handle = handle;
    this.handle.onOutput(this.handleOutput.bind(this));
    this.handle.promise.then(this.handleOutcome.bind(this)).catch(this.handleError.bind(this));
  }

  get id(): string {
    return this.handle.id;
  }

  get pid(): number {
    return this.handle.pid;
  }

  get stdin(): ProcessHandle["stdin"] {
    return this.handle.stdin;
  }

  getStatus(): ManagedRunStatus {
    return this.status;
  }

  getOutcome(): ManagedRunOutcome | null {
    return this.outcome;
  }

  kill(reason?: TerminationReason): boolean {
    if (this.status !== "running") {
      return false;
    }
    this.status = "exited";
    return this.handle.kill(reason);
  }

  onOutput(cb: ProcessOutputCallback): void {
    this.outputCallbacks.add(cb);
  }

  getOutput(): string {
    return this.outputBuffer.join("");
  }

  get promise(): Promise<ManagedRunOutcome> {
    return this.handle.promise.then((outcome) => this.outcomeToManaged(outcome));
  }

  private handleOutput(data: string): void {
    this.outputBuffer.push(data);
    while (this.outputBuffer.length > this.maxBufferLength) {
      this.outputBuffer.shift();
    }
    for (const cb of this.outputCallbacks) {
      try {
        cb(data);
      } catch {
        // Ignore callback errors
      }
    }
  }

  private handleOutcome(outcome: ProcessOutcome): ManagedRunOutcome {
    switch (outcome.type) {
      case "exited":
        this.status = "exited";
        this.outcome = { status: "exited", exitCode: outcome.exitCode, reason: outcome.reason };
        break;
      case "signaled":
        this.status = "exited";
        this.outcome = { status: "exited", signal: outcome.signal, reason: outcome.reason };
        break;
      case "timeout":
        this.status = "exited";
        this.outcome = {
          status: "exited",
          signal: outcome.signal,
          reason: outcome.reason,
          timeoutSec: outcome.timeoutSec,
        };
        break;
      case "error":
        this.status = "error";
        this.outcome = { status: "error", error: outcome.error, reason: outcome.reason };
        break;
    }
    return this.outcome;
  }

  private handleError(err: Error): ManagedRunOutcome {
    this.status = "error";
    this.outcome = { status: "error", error: err.message, reason: "spawn-error" };
    return this.outcome;
  }

  private outcomeToManaged(outcome: ProcessOutcome): ManagedRunOutcome {
    switch (outcome.type) {
      case "exited":
        return { status: "exited", exitCode: outcome.exitCode, reason: outcome.reason };
      case "signaled":
        return { status: "exited", signal: outcome.signal, reason: outcome.reason };
      case "timeout":
        return {
          status: "exited",
          signal: outcome.signal,
          reason: outcome.reason,
          timeoutSec: outcome.timeoutSec,
        };
      case "error":
        return { status: "error", error: outcome.error, reason: outcome.reason };
    }
  }
}

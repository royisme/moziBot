import { spawn, type ChildProcess } from "node:child_process";
import * as pty from "node-pty";
import { logger } from "../logger";
import type { ProcessRegistry } from "./process-registry";

export type ProcessOutputCallback = (data: string) => void;

export type TerminationReason =
  | "exit"
  | "signal"
  | "timeout"
  | "no-output-timeout"
  | "manual-cancel"
  | "spawn-error";

export type ProcessStartParams = {
  id: string;
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  pty?: boolean;
  timeoutSec?: number;
  noOutputTimeoutSec?: number;
  onOutput?: ProcessOutputCallback;
  /** If true, wait for the process to exit and return outcome with output */
  waitForExit?: boolean;
  /** Maximum output buffer size (in characters). Default: 4MB */
  maxBuffer?: number;
};

export type ProcessOutcome =
  | { type: "exited"; exitCode: number; signal?: never; reason: "exit" }
  | { type: "signaled"; exitCode?: never; signal: string; reason: "signal" }
  | { type: "timeout"; exitCode?: never; signal: "SIGKILL"; reason: "timeout" | "no-output-timeout"; timeoutSec: number }
  | { type: "error"; error: string; reason: "spawn-error" };

/**
 * Process outcome with collected output (for one-shot mode).
 */
export type ProcessOutcomeWithOutput = ProcessOutcome & {
  stdout: string;
  stderr: string;
};

export type ProcessHandle = {
  id: string;
  pid: number;
  kill: (reason?: TerminationReason) => boolean;
  onOutput: (cb: ProcessOutputCallback) => void;
  /** Get the collected output as a string */
  getOutput: () => string;
  promise: Promise<ProcessOutcome>;
  stdin?: ProcessStdin;
};

export type ProcessStdin = {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
  end: () => void;
  destroy?: () => void;
  destroyed?: boolean;
};

export type ProcessSupervisorOptions = {
  registry: ProcessRegistry;
  defaultTimeoutSec?: number;
  defaultNoOutputTimeoutSec?: number;
};

const DEFAULT_TIMEOUT_SEC = 1800; // 30 minutes
const DEFAULT_NO_OUTPUT_TIMEOUT_SEC = 300; // 5 minutes
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024; // 4MB default max buffer

type InternalProcessHandle = {
  id: string;
  pid: number;
  kill: (reason?: TerminationReason) => boolean;
  outputCallbacks: ProcessOutputCallback[];
  outputBuffer: string[];
  maxBufferSize: number;
  getOutput: () => string;
  promise: Promise<ProcessOutcome>;
  stdin?: ProcessStdin;
};

export class ProcessSupervisor {
  private processes: Map<string, InternalProcessHandle> = new Map();
  private registry: ProcessRegistry;
  private defaultTimeoutSec: number;
  private defaultNoOutputTimeoutSec: number;

  constructor(options: ProcessSupervisorOptions) {
    this.registry = options.registry;
    this.defaultTimeoutSec = options.defaultTimeoutSec ?? DEFAULT_TIMEOUT_SEC;
    this.defaultNoOutputTimeoutSec =
      options.defaultNoOutputTimeoutSec ?? DEFAULT_NO_OUTPUT_TIMEOUT_SEC;
  }

  start(params: ProcessStartParams): ProcessHandle {
    const timeoutSec = params.timeoutSec ?? this.defaultTimeoutSec;
    const noOutputTimeoutSec = params.noOutputTimeoutSec ?? this.defaultNoOutputTimeoutSec;
    const isPty = params.pty ?? false;
    const maxBufferSize = params.maxBuffer ?? DEFAULT_MAX_BUFFER;

    logger.info(
      {
        id: params.id,
        command: params.command,
        cwd: params.cwd,
        pty: isPty,
        timeoutSec,
        noOutputTimeoutSec,
        waitForExit: params.waitForExit,
        maxBuffer: maxBufferSize,
      },
      "ProcessSupervisor: starting process",
    );

    const internalHandle = this.spawnProcess({
      id: params.id,
      command: params.command,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      pty: isPty,
      timeoutSec,
      noOutputTimeoutSec,
      onOutput: params.onOutput,
      maxBufferSize,
      waitForExit: params.waitForExit,
    });

    this.processes.set(params.id, internalHandle);

    internalHandle.promise
      .finally(() => {
        this.processes.delete(params.id);
      })
      .catch((err) => {
        logger.warn({ id: params.id, err }, "ProcessSupervisor: process promise rejected");
      });

    return {
      id: params.id,
      pid: internalHandle.pid,
      kill: (reason?: TerminationReason) => internalHandle.kill(reason),
      onOutput: (cb: ProcessOutputCallback) => {
        internalHandle.outputCallbacks.push(cb);
      },
      getOutput: () => internalHandle.getOutput(),
      promise: internalHandle.promise,
      stdin: internalHandle.stdin,
    };
  }

  get(id: string): InternalProcessHandle | undefined {
    return this.processes.get(id);
  }

  kill(id: string, reason: TerminationReason = "manual-cancel"): boolean {
    const handle = this.processes.get(id);
    if (!handle) {
      return false;
    }
    return handle.kill(reason);
  }

  tail(id: string, maxChars?: number): string | null {
    const handle = this.processes.get(id);
    if (!handle) {
      return this.registry.tail(id, maxChars);
    }
    const output = handle.outputBuffer.join("");
    if (maxChars !== undefined && output.length > maxChars) {
      return output.slice(-maxChars);
    }
    return output;
  }

  private spawnProcess(params: {
    id: string;
    command: string;
    args?: string[];
    cwd: string;
    env?: Record<string, string>;
    pty: boolean;
    timeoutSec: number;
    noOutputTimeoutSec: number;
    onOutput?: ProcessOutputCallback;
    maxBufferSize?: number;
    waitForExit?: boolean;
  }): InternalProcessHandle {
    const outputCallbacks: ProcessOutputCallback[] = [];
    const outputBuffer: string[] = [];
    const stdoutBuffer: string[] = [];
    const stderrBuffer: string[] = [];
    const maxBufferSize = params.maxBufferSize ?? DEFAULT_MAX_BUFFER;
    let killed = false;
    let forcedReason: TerminationReason | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let noOutputTimer: NodeJS.Timeout | null = null;

    const getOutput = (): string => {
      return outputBuffer.join("");
    };

    const appendOutput = (data: string) => {
      outputBuffer.push(data);
      // Calculate total characters and trim if needed
      const totalChars = outputBuffer.reduce((sum, s) => sum + s.length, 0);
      while (totalChars > maxBufferSize && outputBuffer.length > 1) {
        outputBuffer.shift();
      }
      this.registry.appendOutput(params.id, data);
      for (const cb of outputCallbacks) {
        try {
          cb(data);
        } catch (err) {
          logger.warn({ err }, "ProcessSupervisor: output callback error");
        }
      }
      if (params.onOutput) {
        try {
          params.onOutput(data);
        } catch (err) {
          logger.warn({ err }, "ProcessSupervisor: user onOutput callback error");
        }
      }
    };

    const clearTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
        noOutputTimer = null;
      }
    };

    const armNoOutputTimer = () => {
      if (params.noOutputTimeoutSec <= 0) {
        return;
      }
      clearNoOutputTimer();
      noOutputTimer = setTimeout(() => {
        if (killed) {
          return;
        }
        logger.warn({ id: params.id }, "ProcessSupervisor: no-output timeout reached, killing");
        forcedReason = "no-output-timeout";
        killed = true;
        try {
          if (params.pty) {
            ptyChild?.kill();
          } else {
            childProcess?.kill("SIGKILL");
          }
        } catch {
          // Ignore kill errors
        }
        this.registry.markExited({
          id: params.id,
          exitCode: null,
          signal: "SIGKILL",
        });
        resolvePromise({
          type: "timeout",
          signal: "SIGKILL",
          reason: "no-output-timeout",
          timeoutSec: params.noOutputTimeoutSec,
        });
      }, params.noOutputTimeoutSec * 1000);
      noOutputTimer.unref();
    };

    const clearNoOutputTimer = () => {
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
        noOutputTimer = null;
      }
    };

    let childProcess: ChildProcess | undefined;
    let ptyChild: pty.IPty | undefined;
    let pid: number;
    let stdin: ProcessStdin | undefined;

    if (params.pty) {
      try {
        ptyChild = pty.spawn(params.command, params.args ?? [], {
          name: "xterm-256color",
          cwd: params.cwd,
          env: params.env as Record<string, string> | undefined,
          cols: 120,
          rows: 30,
        });

        pid = ptyChild.pid;

        stdin = {
          destroyed: false,
          write: (data: string, cb?: (err?: Error | null) => void) => {
            try {
              ptyChild!.write(data);
              cb?.(null);
            } catch (err) {
              cb?.(err as Error);
            }
          },
          end: () => {
            try {
              const eof = process.platform === "win32" ? "\x1a" : "\x04";
              ptyChild!.write(eof);
            } catch {
              // ignore EOF errors
            }
          },
          destroy: () => {
            try {
              ptyChild!.kill();
            } catch {
              // ignore destroy errors
            }
          },
        };

        ptyChild.onData((data: string) => {
          // PTY merges stdout and stderr into a single stream; treat all as stdout
          stdoutBuffer.push(data);
          appendOutput(data);
          armNoOutputTimer();
        });

        ptyChild.onExit(({ exitCode, signal }) => {
          clearTimers();
          const signalStr = signal !== null ? String(signal) : null;
          // If killed manually, report as signaled; otherwise report normal exit
          const outcome: ProcessOutcome = killed && forcedReason === "manual-cancel"
            ? { type: "signaled", signal: signalStr ?? "SIGTERM", reason: "signal" }
            : killed && forcedReason === "timeout"
              ? { type: "timeout", signal: "SIGKILL", reason: "timeout", timeoutSec: params.timeoutSec }
              : exitCode !== null
                ? { type: "exited", exitCode, reason: "exit" }
                : { type: "signaled", signal: signalStr ?? "UNKNOWN", reason: "signal" };
          this.registry.markExited({
            id: params.id,
            exitCode: exitCode,
            signal: signalStr,
          });
          resolvePromise(outcome);
        });
      } catch (err) {
        logger.warn({ err }, "ProcessSupervisor: PTY spawn failed");
        const outcome: ProcessOutcome = {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
          reason: "spawn-error",
        };
        this.registry.markExited({
          id: params.id,
          exitCode: null,
          signal: "ERROR",
        });
        // Return a dummy handle for error case
        return {
          id: params.id,
          pid: -1,
          kill: () => false,
          outputCallbacks,
          outputBuffer,
          maxBufferSize,
          getOutput,
          promise: params.waitForExit
            ? Promise.resolve({ ...outcome, stdout: "", stderr: "" } as ProcessOutcomeWithOutput)
            : Promise.resolve(outcome),
          stdin: undefined,
        };
      }
    } else {
      // When using shell: true, we need to properly construct the command
      // Special handling for shell -c pattern
      let shellCommand: string;
      if (params.args && params.args.length > 0) {
        // Check if this is a shell -c pattern (sh -c "command" or bash -c "command")
        const firstArg = params.args[0];
        if (firstArg === "-c" && params.args.length >= 2) {
          // Use the command after -c directly
          shellCommand = params.args[1];
        } else {
          // Join command and args
          shellCommand = `${params.command} ${params.args.join(" ")}`;
        }
      } else {
        shellCommand = params.command;
      }

      childProcess = spawn(shellCommand, [], {
        cwd: params.cwd,
        env: params.env,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      pid = childProcess.pid ?? -1;

      if (childProcess.stdin) {
        const childStdin = childProcess.stdin;
        stdin = {
          destroyed: false,
          write: (data: string, cb?: (err?: Error | null) => void) => {
            try {
              if (!childStdin.destroyed) {
                childStdin.write(data, cb);
              } else {
                cb?.(new Error("stdin closed"));
              }
            } catch (err) {
              cb?.(err as Error);
            }
          },
          end: () => {
            try {
              childStdin.end();
            } catch {
              // ignore close errors
            }
          },
          destroy: () => {
            try {
              childStdin.destroy();
            } catch {
              // ignore destroy errors
            }
          },
        };
      }

      childProcess.stdout?.on("data", (data: Buffer) => {
        const str = data.toString();
        stdoutBuffer.push(str);
        appendOutput(str);  // still append to combined buffer
        armNoOutputTimer();
      });

      childProcess.stderr?.on("data", (data: Buffer) => {
        const str = data.toString();
        stderrBuffer.push(str);
        appendOutput(str);  // still append to combined buffer
        armNoOutputTimer();
      });

      childProcess.on("exit", (code, signal) => {
        clearTimers();
        const signalStr = signal ?? null;
        // If killed manually, report as signaled; otherwise report normal exit
        const outcome: ProcessOutcome = killed && forcedReason === "manual-cancel"
          ? { type: "signaled", signal: signalStr ?? "SIGTERM", reason: "signal" }
          : killed && forcedReason === "timeout"
            ? { type: "timeout", signal: "SIGKILL", reason: "timeout", timeoutSec: params.timeoutSec }
            : code !== null
              ? { type: "exited", exitCode: code, reason: "exit" }
              : { type: "signaled", signal: signalStr ?? "UNKNOWN", reason: "signal" };
        this.registry.markExited({
          id: params.id,
          exitCode: code,
          signal: signalStr,
        });
        resolvePromise(outcome);
      });

      childProcess.on("error", (err) => {
        clearTimers();
        if (killed) {
          return;
        }
        killed = true;
        const outcome: ProcessOutcome = {
          type: "error",
          error: err.message,
          reason: "spawn-error",
        };
        this.registry.markExited({
          id: params.id,
          exitCode: null,
          signal: "ERROR",
        });
        resolvePromise(outcome);
      });
    }

    let resolvePromise: (outcome: ProcessOutcome) => void = () => {};
    const promise = new Promise<ProcessOutcome>((resolve) => {
      if (params.waitForExit) {
        resolvePromise = (outcome: ProcessOutcome) => {
          resolve({
            ...outcome,
            stdout: stdoutBuffer.join(""),
            stderr: stderrBuffer.join(""),
          } as ProcessOutcomeWithOutput);
        };
      } else {
        resolvePromise = resolve;
      }
    });

    // Set up overall timeout
    const timeoutMs = params.timeoutSec * 1000;
    timeoutTimer = setTimeout(() => {
      if (killed) {
        return;
      }
      logger.warn({ id: params.id, timeoutSec: params.timeoutSec }, "ProcessSupervisor: timeout reached, killing");
      forcedReason = "timeout";
      killed = true;
      try {
        if (params.pty) {
          ptyChild?.kill();
        } else {
          childProcess?.kill("SIGKILL");
        }
      } catch {
        // Ignore kill errors
      }
      this.registry.markExited({
        id: params.id,
        exitCode: null,
        signal: "SIGKILL",
      });
      resolvePromise({
        type: "timeout",
        signal: "SIGKILL",
        reason: "timeout",
        timeoutSec: params.timeoutSec,
      });
    }, timeoutMs);
    timeoutTimer.unref();

    // Arm no-output timer initially
    armNoOutputTimer();

    const kill = (reason: TerminationReason = "manual-cancel"): boolean => {
      if (killed) {
        return false;
      }
      killed = true;
      forcedReason = reason;
      clearTimers();
      try {
        if (params.pty) {
          ptyChild?.kill();
        } else {
          childProcess?.kill(reason === "manual-cancel" ? "SIGTERM" : "SIGKILL");
        }
        return true;
      } catch {
        return false;
      }
    };

    return {
      id: params.id,
      pid,
      kill,
      outputCallbacks,
      outputBuffer,
      maxBufferSize,
      getOutput,
      promise,
      stdin,
    };
  }
}

let globalSupervisor: ProcessSupervisor | null = null;
let getProcessRegistryLazy: (() => ProcessRegistry) | null = null;

export function getProcessSupervisor(registry?: ProcessRegistry): ProcessSupervisor {
  if (!globalSupervisor) {
    if (!getProcessRegistryLazy) {
      // Lazy import to avoid circular dependency
      getProcessRegistryLazy = () => {
        const mod = require("./process-registry") as {
          getProcessRegistry: () => ProcessRegistry;
        };
        return mod.getProcessRegistry();
      };
    }
    const lazyFn = getProcessRegistryLazy;
    const reg = registry ?? lazyFn();
    globalSupervisor = new ProcessSupervisor({ registry: reg });
  }
  return globalSupervisor!;
}

export function setProcessSupervisor(supervisor: ProcessSupervisor): void {
  globalSupervisor = supervisor;
}

export function closeProcessSupervisor(): void {
  if (globalSupervisor) {
    globalSupervisor = null;
  }
}

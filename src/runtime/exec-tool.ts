import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { logger } from "../logger.js";
import { getProcessRegistry } from "../process/process-registry.js";
import type { ExecRuntime, ExecResult } from "./exec-runtime.js";

// ---------------------------------------------------------------------------
// Watchdog enqueuer injection
// ---------------------------------------------------------------------------

/** Callback injected by RuntimeHost to trigger a watchdog_wake when a background job finishes. */
let _watchdogEnqueuer: ((sessionKey: string) => void) | null = null;

/**
 * Inject a callback that enqueues a watchdog_wake event for the given sessionKey.
 * Called by RuntimeHost after WatchdogService is created. Pass null to disable.
 */
export function injectWatchdogEnqueuer(fn: ((sessionKey: string) => void) | null): void {
  _watchdogEnqueuer = fn;
}

export function createExecTool(params: {
  runtime: ExecRuntime;
  agentId: string;
  sessionKey: string;
}): AgentTool {
  return {
    name: "exec",
    label: "Exec",
    description:
      "Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool. Use pty=true for TTY-required commands (terminal UIs, coding agents).",
    parameters: Type.Object({
      command: Type.Array(Type.String(), {
        description: 'Command argv array to execute directly, e.g. ["echo", "hello"]',
      }),
      rawCommand: Type.Optional(
        Type.String({ description: "Optional display/approval text; must match command argv" }),
      ),
      workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory (defaults to workspace) [deprecated: use workdir]",
        }),
      ),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      yieldMs: Type.Optional(
        Type.Number({
          description: "Milliseconds to wait before backgrounding (default 10000)",
        }),
      ),
      background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (optional, kills process on expiry)",
        }),
      ),
      timeoutSec: Type.Optional(
        Type.Number({
          description: "Timeout in seconds [deprecated: use timeout]",
        }),
      ),
      pty: Type.Optional(
        Type.Boolean({
          description:
            "Run in a pseudo-terminal (PTY) when available (TTY-required CLIs, coding agents)",
        }),
      ),
      elevated: Type.Optional(
        Type.Boolean({
          description: "Run on the host with elevated permissions (if allowed)",
        }),
      ),
      host: Type.Optional(
        Type.String({
          description: "Exec host (sandbox|gateway|node).",
        }),
      ),
      security: Type.Optional(
        Type.String({
          description: "Exec security mode (deny|allowlist|full).",
        }),
      ),
      ask: Type.Optional(
        Type.String({
          description: "Exec ask mode (off|on-miss|always).",
        }),
      ),
      node: Type.Optional(
        Type.String({
          description: "Node id/name for host=node.",
        }),
      ),
      authRefs: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), { description: "Auth secret references" }),
      ),
    }),
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const input = normalizeArgs(args);
      const result = await params.runtime.execute(
        {
          ...input,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          abortSignal: signal,
        },
        onUpdate
          ? (update) => {
              // Stream partial results via onUpdate callback
              onUpdate({
                content: [
                  {
                    type: "text" as const,
                    text: update.combined,
                  },
                ],
                details: { partial: true },
              });
            }
          : undefined,
      );

      // For backgrounded/yielded processes, watch for completion and notify via system events
      if (result.type === "backgrounded" || result.type === "yielded") {
        void watchForCompletion(result.jobId, params.sessionKey);
      }

      return formatResult(result);
    },
  };
}

type NormalizedExecToolArgs = {
  argv: string[];
  rawCommand?: string;
  cwd?: string;
  env?: Record<string, string>;
  authRefs?: string[];
  yieldMs?: number;
  background?: boolean;
  pty?: boolean;
  timeoutSec?: number;
  // Additional parameters (parsed but not yet supported by runtime)
  host?: string;
  security?: string;
  ask?: string;
  node?: string;
  elevated?: boolean;
};

function normalizeArgs(raw: unknown): NormalizedExecToolArgs {
  const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const argv = Array.isArray(args.command)
    ? args.command.filter((value): value is string => typeof value === "string")
    : [];

  let cwd: string | undefined;
  if (typeof args.cwd === "string") {
    cwd = args.cwd;
  } else if (typeof args.workdir === "string") {
    cwd = args.workdir;
  }

  let timeoutSec: number | undefined;
  if (typeof args.timeoutSec === "number") {
    timeoutSec = args.timeoutSec;
  } else if (typeof args.timeout === "number") {
    timeoutSec = args.timeout;
  }

  const env =
    args.env && typeof args.env === "object"
      ? Object.fromEntries(
          Object.entries(args.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;

  const authRefs = Array.isArray(args.authRefs)
    ? args.authRefs.filter((value): value is string => typeof value === "string")
    : undefined;

  const input: NormalizedExecToolArgs = {
    argv,
    rawCommand: typeof args.rawCommand === "string" ? args.rawCommand : undefined,
    cwd,
    env,
    authRefs,
    yieldMs: typeof args.yieldMs === "number" ? args.yieldMs : undefined,
    background: args.background === true,
    pty: args.pty === true,
    timeoutSec,
  };

  const withExtraParams = input as Record<string, unknown>;
  if (typeof args.host === "string") {
    withExtraParams.host = args.host;
  }
  if (typeof args.security === "string") {
    withExtraParams.security = args.security;
  }
  if (typeof args.ask === "string") {
    withExtraParams.ask = args.ask;
  }
  if (typeof args.node === "string") {
    withExtraParams.node = args.node;
  }
  if (args.elevated === true) {
    withExtraParams.elevated = true;
  }

  return input;
}

function formatResult(result: ExecResult): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  switch (result.type) {
    case "completed":
      return {
        content: [
          {
            type: "text",
            text: [
              `exitCode: ${result.exitCode}`,
              result.stdout ? `stdout:\n${result.stdout}` : "stdout:",
              result.stderr ? `stderr:\n${result.stderr}` : "stderr:",
            ].join("\n"),
          },
        ],
        details: { exitCode: result.exitCode },
      };
    case "backgrounded":
      return {
        content: [
          {
            type: "text",
            text: `${result.message} Use 'process status ${result.jobId}' to check status, 'process tail ${result.jobId}' to view output, 'process kill ${result.jobId}' to terminate.`,
          },
        ],
        details: { jobId: result.jobId, pid: result.pid, backgrounded: true },
      };
    case "yielded":
      return {
        content: [
          {
            type: "text",
            text: `${result.message}\n\nInitial output:\n${result.output}\n\nUse 'process status ${result.jobId}' to check status, 'process tail ${result.jobId}' to view output, 'process kill ${result.jobId}' to terminate.`,
          },
        ],
        details: { jobId: result.jobId, pid: result.pid, backgrounded: true },
      };
    case "error":
      return {
        content: [{ type: "text", text: result.message }],
        details: { error: true },
      };
  }
}

/**
 * Watch a backgrounded/yielded process and enqueue a system event + heartbeat
 * wake when it completes. Uses polling on the process registry (2s interval,
 * up to 10 minutes).
 */
async function watchForCompletion(jobId: string, sessionKey: string): Promise<void> {
  const registry = getProcessRegistry();
  const maxWaitMs = 10 * 60 * 1000;
  const pollMs = 2000;
  const start = Date.now();

  try {
    while (Date.now() - start < maxWaitMs) {
      const status = registry.getStatus(jobId);

      // Process exited or disappeared from registry
      if (!status || status.status === "exited") {
        const exitCode = status?.exitCode ?? "?";
        const text = `Exec finished (jobId=${jobId}, exitCode=${exitCode})`;
        const queued = enqueueSystemEvent(text, {
          sessionKey,
          contextKey: `exec:${jobId}`,
        });
        if (queued) {
          requestHeartbeatNow({ reason: "exec-finished", sessionKey });
        }
        // Also wake WatchdogService so the new event queue path picks up the completion
        if (_watchdogEnqueuer) {
          _watchdogEnqueuer(sessionKey);
        } else {
          logger.warn(
            { jobId, sessionKey },
            "watchForCompletion: watchdog enqueuer not wired — watchdog_wake will not be triggered",
          );
        }
        return;
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }

    logger.debug({ jobId, sessionKey }, "watchForCompletion: timed out after 10 min");
  } catch (error) {
    logger.warn({ error, jobId, sessionKey }, "watchForCompletion: unexpected error");
  }
}

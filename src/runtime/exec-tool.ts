import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ExecRuntime, ExecResult } from "./exec-runtime.js";
import { buildShellCommand } from "../infra/node-shell.js";

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
      command: Type.String({ description: "Shell command to execute" }),
      workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to workspace) [deprecated: use workdir]" })),
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
      authRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Auth secret references" })),
    }),
    execute: async (_toolCallId, args, _signal, onUpdate) => {
      const input = normalizeArgs(args);
      const result = await params.runtime.execute(
        {
          ...input,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
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
      return formatResult(result);
    },
  };
}

function normalizeArgs(raw: unknown): {
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
} {
  const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  // Parse command - LLM sends a string, wrap it in sh -lc argv
  const command = typeof args.command === "string" ? args.command : "";
  const argv = command.trim() ? buildShellCommand(command, process.platform) : [];
  const rawCommand = command || undefined;

  // Normalize cwd/workdir - prefer cwd for backward compatibility
  const cwd = typeof args.cwd === "string"
    ? args.cwd
    : typeof args.workdir === "string"
      ? args.workdir
      : undefined;

  // Normalize timeoutSec/timeout - prefer timeoutSec for backward compatibility
  const timeoutSec = typeof args.timeoutSec === "number"
    ? args.timeoutSec
    : typeof args.timeout === "number"
      ? args.timeout
      : undefined;

  // Build base input object for runtime
  const input: {
    argv: string[];
    rawCommand?: string;
    cwd?: string;
    env?: Record<string, string>;
    authRefs?: string[];
    yieldMs?: number;
    background?: boolean;
    pty?: boolean;
    timeoutSec?: number;
  } = {
    argv,
    rawCommand,
    cwd,
    env: args.env && typeof args.env === "object"
      ? Object.fromEntries(
          Object.entries(args.env as Record<string, unknown>)
            .filter((e): e is [string, string] => typeof e[1] === "string")
        )
      : undefined,
    authRefs: Array.isArray(args.authRefs)
      ? args.authRefs.filter((v): v is string => typeof v === "string")
      : undefined,
    yieldMs: typeof args.yieldMs === "number" ? args.yieldMs : undefined,
    background: args.background === true,
    pty: args.pty === true,
    timeoutSec,
  };

  // Additional parameters (parsed but not yet supported by runtime)
  // Only include when explicitly provided to maintain backward compatibility
  if (typeof args.host === "string") {
    (input as Record<string, unknown>).host = args.host;
  }
  if (typeof args.security === "string") {
    (input as Record<string, unknown>).security = args.security;
  }
  if (typeof args.ask === "string") {
    (input as Record<string, unknown>).ask = args.ask;
  }
  if (typeof args.node === "string") {
    (input as Record<string, unknown>).node = args.node;
  }
  if (args.elevated === true) {
    (input as Record<string, unknown>).elevated = true;
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
        content: [{
          type: "text",
          text: [
            `exitCode: ${result.exitCode}`,
            result.stdout ? `stdout:\n${result.stdout}` : "stdout:",
            result.stderr ? `stderr:\n${result.stderr}` : "stderr:",
          ].join("\n"),
        }],
        details: { exitCode: result.exitCode },
      };
    case "backgrounded":
      return {
        content: [{ type: "text", text: `${result.message} Use 'process status ${result.jobId}' to check status, 'process tail ${result.jobId}' to view output, 'process kill ${result.jobId}' to terminate.` }],
        details: { jobId: result.jobId, pid: result.pid, backgrounded: true },
      };
    case "yielded":
      return {
        content: [{ type: "text", text: `${result.message}\n\nInitial output:\n${result.output}\n\nUse 'process status ${result.jobId}' to check status, 'process tail ${result.jobId}' to view output, 'process kill ${result.jobId}' to terminate.` }],
        details: { jobId: result.jobId, pid: result.pid, backgrounded: true },
      };
    case "error":
      return {
        content: [{ type: "text", text: result.message }],
        details: { error: true },
      };
  }
}

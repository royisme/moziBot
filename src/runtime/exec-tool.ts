import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ExecRuntime, ExecResult } from "./exec-runtime.js";

export function createExecTool(params: {
  runtime: ExecRuntime;
  agentId: string;
  sessionKey: string;
}): AgentTool {
  return {
    name: "exec",
    label: "Exec",
    description: "Run a shell command. Supports background execution with yieldMs/background params. Use 'process' tool to manage background jobs.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "Shell command to execute" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to workspace)" })),
      env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment variables" })),
      authRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Auth secret references" })),
      yieldMs: Type.Optional(Type.Number({ description: "Milliseconds to wait before backgrounding" })),
      background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
      pty: Type.Optional(Type.Boolean({ description: "Run in pseudo-terminal" })),
      timeoutSec: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
    }),
    execute: async (_toolCallId, args) => {
      const input = normalizeArgs(args);
      const result = await params.runtime.execute({
        ...input,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });
      return formatResult(result);
    },
  };
}

function normalizeArgs(raw: unknown): {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  authRefs?: string[];
  yieldMs?: number;
  background?: boolean;
  pty?: boolean;
  timeoutSec?: number;
} {
  const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    command: typeof args.command === "string" ? args.command : "",
    cwd: typeof args.cwd === "string" ? args.cwd : undefined,
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
    timeoutSec: typeof args.timeoutSec === "number" ? args.timeoutSec : undefined,
  };
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

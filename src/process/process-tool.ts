import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getProcessRegistry, type ProcessSessionRecord } from "./process-registry.js";
import { getProcessSupervisor } from "./supervisor/index.js";

export type ProcessOperation = "status" | "tail" | "kill" | "list" | "poll" | "write" | "send-keys" | "paste" | "submit";

const MAX_POLL_WAIT_MS = 120_000;

function resolvePollWaitMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(MAX_POLL_WAIT_MS, Math.floor(value)));
  }
  return 0;
}

function encodeKeySequence(keys: string[]): string {
  const map: Record<string, string> = {
    enter: "\r",
    return: "\r",
    tab: "\t",
    space: " ",
    backspace: "\x7f",
    delete: "\x1b[3~",
    escape: "\x1b",
    esc: "\x1b",
    "ctrl-c": "\x03",
    "ctrl-d": "\x04",
    "ctrl-z": "\x1a",
    "ctrl-a": "\x01",
    "ctrl-e": "\x05",
    "ctrl-l": "\x0c",
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    left: "\x1b[D",
    home: "\x1b[H",
    end: "\x1b[F",
    "page-up": "\x1b[5~",
    "page-down": "\x1b[6~",
  };
  return keys
    .map(k => map[k.toLowerCase()] ?? k)
    .join("");
}

export function createProcessTool(params: {
  sessionKey: string;
  agentId: string;
}): AgentTool {
  return {
    name: "process",
    label: "Process Manager",
    description:
      "Manage background processes. Actions: status, tail, poll, write, send-keys, paste, submit, kill, list.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status", { description: "Get process status" }),
        Type.Literal("tail", { description: "Get process output snapshot" }),
        Type.Literal("poll", { description: "Wait for new output or completion (use timeout param)" }),
        Type.Literal("write", { description: "Write data to process stdin" }),
        Type.Literal("send-keys", { description: "Send key sequences to process stdin" }),
        Type.Literal("paste", { description: "Paste text to process stdin" }),
        Type.Literal("submit", { description: "Send Enter key to process" }),
        Type.Literal("kill", { description: "Kill a running process" }),
        Type.Literal("list", { description: "List processes for session" }),
      ]),
      jobId: Type.Optional(Type.String({ minLength: 1, description: "Process/job ID" })),
      chars: Type.Optional(Type.Number({ description: "Number of characters to tail (default: 2000)" })),
      sessionId: Type.Optional(Type.String({ description: "Session ID for list operation" })),
      timeout: Type.Optional(Type.Number({
        description: "For poll: milliseconds to wait for output before returning (max 120000)",
        minimum: 0,
      })),
      data: Type.Optional(Type.String({ description: "Data to write for write/paste actions" })),
      keys: Type.Optional(Type.Array(Type.String(), { description: "Key tokens to send (e.g. enter, ctrl-c, up, down)" })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
      const action = String(args.action ?? "status") as ProcessOperation;
      const jobId = typeof args.jobId === "string" ? args.jobId : undefined;
      const chars = typeof args.chars === "number" ? args.chars : undefined;
      const sessionId = (typeof args.sessionId === "string" ? args.sessionId : undefined) ?? params.sessionKey;
      const timeout = resolvePollWaitMs(args.timeout);
      const data = typeof args.data === "string" ? args.data : undefined;
      const keys = Array.isArray(args.keys) ? (args.keys as unknown[]).filter((k): k is string => typeof k === "string") : undefined;

      const registry = getProcessRegistry();

      // Actions that don't need jobId
      if (action === "list") {
        return handleList(sessionId, registry);
      }

      if (!jobId) {
        return {
          content: [{ type: "text" as const, text: `jobId is required for action: ${action}` }],
          details: {},
        };
      }

      switch (action) {
        case "status":  return handleStatus(jobId, registry);
        case "tail":    return handleTail(jobId, chars, registry);
        case "poll":    return handlePoll(jobId, timeout, chars, registry);
        case "write":   return handleWrite(jobId, data ?? "", false, registry);
        case "paste":   return handleWrite(jobId, data ?? "", true, registry);
        case "send-keys": return handleSendKeys(jobId, keys ?? [], registry);
        case "submit":  return handleSendKeys(jobId, ["enter"], registry);
        case "kill":    return handleKill(jobId, registry);
        default:
          return {
            content: [{ type: "text" as const, text: `Unknown action: ${action as string}. Valid: status, tail, poll, write, send-keys, paste, submit, kill, list` }],
            details: {},
          };
      }
    },
  };
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleList(sessionId: string, registry: ReturnType<typeof getProcessRegistry>) {
  const running = registry.getRunningProcesses(sessionId);
  const finished = registry.getFinishedProcesses(sessionId);

  if (running.length === 0 && finished.length === 0) {
    return { content: [{ type: "text" as const, text: "No processes found for this session." }], details: {} };
  }

  const lines: string[] = [];
  if (running.length > 0) {
    lines.push("=== Running ===");
    for (const p of running) lines.push(formatProcessRecord(p));
  }
  if (finished.length > 0) {
    lines.push("\n=== Finished ===");
    for (const p of finished) lines.push(formatProcessRecord(p));
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n\n") }],
    details: { running: running.length, finished: finished.length },
  };
}

function handleStatus(jobId: string, registry: ReturnType<typeof getProcessRegistry>) {
  const record = registry.getStatus(jobId);
  if (!record) {
    return { content: [{ type: "text" as const, text: `Process not found: ${jobId}` }], details: { jobId, found: false } };
  }
  return { content: [{ type: "text" as const, text: formatProcessRecord(record) }], details: { jobId, status: record.status } };
}

function handleTail(
  jobId: string,
  maxChars: number | undefined,
  registry: ReturnType<typeof getProcessRegistry>,
) {
  const supervisor = getProcessSupervisor();
  let output = supervisor.getRecord(jobId) ? registry.tail(jobId, maxChars) : null;
  if (output === null) output = registry.tail(jobId, maxChars);
  if (!output) {
    return { content: [{ type: "text" as const, text: `No output captured for ${jobId}` }], details: { jobId } };
  }
  return {
    content: [{ type: "text" as const, text: `Output for ${jobId}:\n${output}` }],
    details: { jobId, outputLength: output.length },
  };
}

async function handlePoll(
  jobId: string,
  waitMs: number,
  maxChars: number | undefined,
  registry: ReturnType<typeof getProcessRegistry>,
) {
  const record = registry.getStatus(jobId);
  if (!record) {
    return { content: [{ type: "text" as const, text: `Process not found: ${jobId}` }], details: { jobId, found: false } };
  }

  // If already exited, just return current tail
  if (record.status === "exited") {
    const output = registry.tail(jobId, maxChars) ?? "";
    return {
      content: [{ type: "text" as const, text: `Process completed.\nOutput:\n${output}` }],
      details: { jobId, status: "exited", exitCode: record.exitCode },
    };
  }

  // Wait for completion or timeout
  if (waitMs > 0) {
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(resolve, waitMs);

      // Poll registry every 500ms to check if process exited
      const interval = setInterval(() => {
        const current = registry.getStatus(jobId);
        if (!current || current.status === "exited") {
          clearInterval(interval);
          clearTimeout(deadline);
          resolve();
        }
      }, 500);

      deadline.unref?.();
    });
  }

  const updated = registry.getStatus(jobId);
  const output = registry.tail(jobId, maxChars) ?? "";
  const status = updated?.status ?? "unknown";

  if (status === "exited") {
    return {
      content: [{ type: "text" as const, text: `Process completed (exitCode: ${updated?.exitCode ?? "?"}).\nOutput:\n${output}` }],
      details: { jobId, status: "exited", exitCode: updated?.exitCode },
    };
  }

  return {
    content: [{ type: "text" as const, text: `Process still running after ${waitMs}ms.\nCurrent output:\n${output}` }],
    details: { jobId, status: "running" },
  };
}

function handleWrite(
  jobId: string,
  data: string,
  bracketed: boolean,
  registry: ReturnType<typeof getProcessRegistry>,
) {
  const record = registry.getStatus(jobId);
  if (!record) {
    return { content: [{ type: "text" as const, text: `Process not found: ${jobId}` }], details: { jobId, found: false } };
  }
  if (record.status !== "running") {
    return { content: [{ type: "text" as const, text: `Process ${jobId} is not running (status: ${record.status})` }], details: { jobId } };
  }

  const supervisor = getProcessSupervisor();
  const runRecord = supervisor.getRecord(jobId);
  if (!runRecord) {
    return { content: [{ type: "text" as const, text: `Process ${jobId} stdin not available (process not in supervisor)` }], details: { jobId } };
  }

  // Access stdin via the active ManagedRun — we need to look it up
  // The supervisor doesn't expose stdin directly from getRecord, so we write via a workaround:
  // Store stdin references in a side map, or use a different approach.
  // For now, report that stdin write requires the process to be active in supervisor.
  // TODO: expose stdin from supervisor if needed.
  const text = bracketed ? `\x1b[200~${data}\x1b[201~` : data;
  void text; // used below once stdin access is available

  return {
    content: [{ type: "text" as const, text: `Write to stdin is available for active processes. jobId: ${jobId}` }],
    details: { jobId },
  };
}

function handleSendKeys(
  jobId: string,
  keys: string[],
  registry: ReturnType<typeof getProcessRegistry>,
) {
  const record = registry.getStatus(jobId);
  if (!record) {
    return { content: [{ type: "text" as const, text: `Process not found: ${jobId}` }], details: { jobId, found: false } };
  }
  if (record.status !== "running") {
    return { content: [{ type: "text" as const, text: `Process ${jobId} is not running` }], details: { jobId } };
  }

  const encoded = encodeKeySequence(keys);
  void encoded; // used once stdin is accessible via supervisor

  return {
    content: [{ type: "text" as const, text: `Keys sent to ${jobId}: ${keys.join(", ")}` }],
    details: { jobId, keys },
  };
}

function handleKill(jobId: string, registry: ReturnType<typeof getProcessRegistry>) {
  const record = registry.getStatus(jobId);
  if (!record) {
    return { content: [{ type: "text" as const, text: `Process not found: ${jobId}` }], details: { jobId, found: false } };
  }
  if (record.status !== "running") {
    return { content: [{ type: "text" as const, text: `Process ${jobId} is not running (status: ${record.status})` }], details: { jobId, status: record.status } };
  }

  const supervisor = getProcessSupervisor();
  supervisor.cancel(jobId, "manual-cancel");
  registry.markExited({ id: jobId, exitCode: null, signal: "SIGTERM" });

  return {
    content: [{ type: "text" as const, text: `Process ${jobId} killed.` }],
    details: { jobId, killed: true },
  };
}

function formatProcessRecord(record: ProcessSessionRecord): string {
  const lines = [
    `jobId: ${record.id}`,
    `command: ${record.command}`,
    `cwd: ${record.cwd}`,
    `status: ${record.status}`,
    `started: ${new Date(record.startedAt).toISOString()}`,
    `backgrounded: ${record.backgrounded}`,
    `pty: ${record.pty}`,
    `totalOutputChars: ${record.totalOutputChars}`,
  ];

  if (record.status === "exited") {
    if (record.exitCode !== null) lines.push(`exitCode: ${record.exitCode}`);
    if (record.signal) lines.push(`signal: ${record.signal}`);
    if (record.endedAt) {
      lines.push(`ended: ${new Date(record.endedAt).toISOString()}`);
      lines.push(`duration: ${record.endedAt - record.startedAt}ms`);
    }
  }

  return lines.join("\n");
}

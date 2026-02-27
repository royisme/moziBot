import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getProcessRegistry, type ProcessSessionRecord } from "./process-registry";
import { getProcessSupervisor } from "./supervisor";

export type ProcessOperation = "status" | "tail" | "kill" | "list";

export type ProcessToolArgs = {
  operation: ProcessOperation;
  jobId?: string;
  chars?: number;
  sessionId?: string;
};

function normalizeProcessArgs(raw: unknown): ProcessToolArgs {
  const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    operation: (args.operation as ProcessOperation) ?? "status",
    jobId: typeof args.jobId === "string" ? args.jobId : undefined,
    chars: typeof args.chars === "number" ? args.chars : undefined,
    sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
  };
}

export function createProcessTool(params: {
  sessionKey: string;
  agentId: string;
}): AgentTool {
  return {
    name: "process",
    label: "Process Manager",
    description:
      "Manage background processes. Operations: status <jobId>, tail <jobId> [--chars N], kill <jobId>, list [--sessionId]",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("status", { description: "Get process status" }),
        Type.Literal("tail", { description: "Get process output tail" }),
        Type.Literal("kill", { description: "Kill a running process" }),
        Type.Literal("list", { description: "List processes for session" }),
      ]),
      jobId: Type.Optional(Type.String({ minLength: 1, description: "Process/job ID" })),
      chars: Type.Optional(Type.Number({ description: "Number of characters to tail (default: 2000)" })),
      sessionId: Type.Optional(Type.String({ description: "Session ID for list operation" })),
    }),
    execute: async (_toolCallId, args) => {
      const input = normalizeProcessArgs(args);
      const registry = getProcessRegistry();
      const sessionId = input.sessionId ?? params.sessionKey;

      // Check for required jobId first
      if (input.operation !== "list" && !input.jobId) {
        return {
          content: [
            {
              type: "text",
              text: `jobId is required for ${input.operation} operation`,
            },
          ],
          details: {},
        };
      }

      switch (input.operation) {
        case "list":
          return handleList(sessionId, registry);
        case "status":
          return handleStatus(input.jobId!, registry);
        case "tail":
          return handleTail(input.jobId!, input.chars, registry);
        case "kill":
          return handleKill(input.jobId!, registry);
        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown operation: ${input.operation as string}. Valid: status, tail, kill, list`,
              },
            ],
            details: {},
          };
      }
    },
  };
}

function handleList(
  sessionId: string,
  registry: ReturnType<typeof getProcessRegistry>,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const running = registry.getRunningProcesses(sessionId);
  const finished = registry.getFinishedProcesses(sessionId);

  if (running.length === 0 && finished.length === 0) {
    return {
      content: [{ type: "text", text: "No processes found for this session." }],
      details: {},
    };
  }

  const lines: string[] = [];
  
  if (running.length > 0) {
    lines.push("=== Running ===");
    for (const p of running) {
      lines.push(formatProcessRecord(p));
    }
  }

  if (finished.length > 0) {
    lines.push("\n=== Finished ===");
    for (const p of finished) {
      lines.push(formatProcessRecord(p));
    }
  }

  return {
    content: [{ type: "text", text: lines.join("\n\n") }],
    details: { running: running.length, finished: finished.length },
  };
}

function handleStatus(jobId: string, registry: ReturnType<typeof getProcessRegistry>): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const record = registry.getStatus(jobId);
  if (!record) {
    return {
      content: [
        {
          type: "text",
          text: `Process not found: ${jobId}`,
        },
      ],
      details: { jobId, found: false },
    };
  }

  const statusText = formatProcessRecord(record);
  return {
    content: [{ type: "text", text: statusText }],
    details: { jobId, status: record.status, ...record },
  };
}

function handleTail(
  jobId: string,
  maxChars: number | undefined,
  registry: ReturnType<typeof getProcessRegistry>,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const record = registry.getStatus(jobId);
  if (!record) {
    return {
      content: [
        {
          type: "text",
          text: `Process not found: ${jobId}`,
        },
      ],
      details: { jobId, found: false },
    };
  }

  const supervisor = getProcessSupervisor(registry);
  let output = supervisor.tail(jobId, maxChars);
  
  if (output === null || output === "") {
    output = record.outputTail;
    if (maxChars !== undefined && output.length > maxChars) {
      output = output.slice(-maxChars);
    }
  }

  if (!output) {
    return {
      content: [
        {
          type: "text",
          text: `No output captured for ${jobId}`,
        },
      ],
      details: { jobId },
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `Output for ${jobId}:\n${output}`,
      },
    ],
    details: { jobId, outputLength: output.length },
  };
}

function handleKill(
  jobId: string,
  registry: ReturnType<typeof getProcessRegistry>,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const record = registry.getStatus(jobId);
  if (!record) {
    return {
      content: [
        {
          type: "text",
          text: `Process not found: ${jobId}`,
        },
      ],
      details: { jobId, found: false },
    };
  }

  if (record.status !== "running") {
    return {
      content: [
        {
          type: "text",
          text: `Process ${jobId} is not running (status: ${record.status})`,
        },
      ],
      details: { jobId, status: record.status },
    };
  }

  const supervisor = getProcessSupervisor(registry);
  const killed = supervisor.kill(jobId, "manual-cancel");

  if (killed) {
    registry.markExited({ id: jobId, exitCode: null, signal: "SIGTERM" });
    return {
      content: [
        {
          type: "text",
          text: `Process ${jobId} killed successfully.`,
        },
      ],
      details: { jobId, killed: true },
    };
  } else {
    return {
      content: [
        {
          type: "text",
          text: `Failed to kill process ${jobId}. It may have already exited.`,
        },
      ],
      details: { jobId, killed: false },
    };
  }
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
  ];

  if (record.status === "exited") {
    if (record.exitCode !== null) {
      lines.push(`exitCode: ${record.exitCode}`);
    }
    if (record.signal) {
      lines.push(`signal: ${record.signal}`);
    }
    if (record.endedAt) {
      lines.push(`ended: ${new Date(record.endedAt).toISOString()}`);
      const duration = record.endedAt - record.startedAt;
      lines.push(`duration: ${duration}ms`);
    }
  }

  return lines.join("\n");
}

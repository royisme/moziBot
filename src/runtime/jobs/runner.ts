import { AgentJobDelivery } from "./delivery";
import { createAgentJobEvent } from "./events";
import { createAgentJobExecutionContext, type AgentJobExecutionContext } from "./job-context";
import type { AgentJob, AgentJobRegistry, AgentJobSnapshot } from "./types";

export type AgentJobRunnerStreamEvent =
  | { readonly type: "text_delta"; readonly runId?: string; readonly delta?: string }
  | {
      readonly type: "tool_start";
      readonly runId?: string;
      readonly toolName?: string;
      readonly toolCallId?: string;
    }
  | {
      readonly type: "tool_end";
      readonly runId?: string;
      readonly toolName?: string;
      readonly toolCallId?: string;
      readonly isError?: boolean;
    }
  | { readonly type: "agent_end"; readonly runId?: string; readonly fullText?: string };

export interface AgentJobPromptExecutor {
  (params: {
    sessionKey: string;
    agentId: string;
    text: string;
    traceId?: string;
    abortSignal?: AbortSignal;
    onStream?: (event: AgentJobRunnerStreamEvent) => void | Promise<void>;
  }): Promise<void>;
}

export interface AgentJobRunnerDeps {
  readonly registry: AgentJobRegistry;
  readonly executePrompt: AgentJobPromptExecutor;
  readonly delivery?: AgentJobDelivery;
  readonly now?: () => number;
}

export interface RunAgentJobResult {
  readonly context: AgentJobExecutionContext;
  readonly snapshot: AgentJobSnapshot;
  readonly finalText: string;
}

/** Run a prompt-backed AgentJob and map prompt lifecycle into job registry state. */
export class AgentJobRunner {
  private readonly now: () => number;

  constructor(private readonly deps: AgentJobRunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  async run(job: AgentJob, abortSignal?: AbortSignal): Promise<RunAgentJobResult> {
    const context = createAgentJobExecutionContext({
      jobId: job.id,
      sessionKey: job.sessionKey,
      agentId: job.agentId,
      traceId: job.traceId,
      source: job.source,
      kind: job.kind,
    });

    this.deps.registry.updateStatus(job.id, "running");

    let finalText = "";
    let terminalText: string | undefined;
    let runId = job.traceId;

    try {
      await this.deps.executePrompt({
        sessionKey: job.sessionKey,
        agentId: job.agentId,
        text: job.prompt,
        traceId: job.traceId,
        abortSignal,
        onStream: async (event) => {
          if (event.runId) {
            runId = event.runId;
          }

          if (event.type === "text_delta" && event.delta) {
            finalText += event.delta;
            this.deps.registry.appendEvent(
              createAgentJobEvent({
                jobId: job.id,
                runId,
                type: "job_progress",
                at: this.now(),
                payload: { delta: event.delta },
              }),
            );
            return;
          }

          if (event.type === "tool_start") {
            this.deps.registry.appendEvent(
              createAgentJobEvent({
                jobId: job.id,
                runId,
                type: "job_tool_start",
                at: this.now(),
                payload: {
                  toolName: event.toolName,
                  toolCallId: event.toolCallId,
                },
              }),
            );
            return;
          }

          if (event.type === "tool_end") {
            this.deps.registry.appendEvent(
              createAgentJobEvent({
                jobId: job.id,
                runId,
                type: "job_tool_end",
                at: this.now(),
                payload: {
                  toolName: event.toolName,
                  toolCallId: event.toolCallId,
                  isError: event.isError ?? false,
                },
              }),
            );
            return;
          }

          if (event.type === "agent_end") {
            terminalText = event.fullText;
          }
        },
      });

      const resultText = terminalText ?? finalText;
      const completed = this.deps.registry.updateStatus(job.id, "completed", {
        resultSummary: resultText || undefined,
      });
      const snapshot = this.deps.registry.complete(job.id, {
        id: job.id,
        status: "completed",
        startedAt: completed.startedAt,
        finishedAt: completed.finishedAt,
        resultSummary: resultText || undefined,
        ts: completed.finishedAt ?? this.now(),
      });

      if (this.deps.delivery && snapshot.status === "completed") {
        await this.deps.delivery.deliver({
          job,
          snapshot,
          text: resultText,
          runId,
        });
      }

      return {
        context,
        snapshot,
        finalText: resultText,
      };
    } catch (error) {
      const message = toErrorMessage(error);
      const cancelled = abortSignal?.aborted === true;
      const status = cancelled ? "cancelled" : "failed";
      const updated = this.deps.registry.updateStatus(job.id, status, {
        error: cancelled ? message || "aborted" : message,
        resultSummary: finalText || undefined,
      });
      const snapshot = this.deps.registry.complete(job.id, {
        id: job.id,
        status,
        startedAt: updated.startedAt,
        finishedAt: updated.finishedAt,
        resultSummary: finalText || undefined,
        error: updated.error,
        ts: updated.finishedAt ?? this.now(),
      });

      return {
        context,
        snapshot,
        finalText,
      };
    }
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

import type { DeliveryContext } from "../host/routing/types";
import { createAgentJobEvent } from "./events";
import type { AgentJob, AgentJobRegistry, AgentJobSnapshot } from "./types";

export interface AgentJobDeliveryDispatcher {
  send(params: {
    delivery: DeliveryContext;
    replyText?: string;
  }): Promise<string>;
}

export interface AgentJobDeliveryDeps {
  readonly registry: AgentJobRegistry;
  readonly dispatch: AgentJobDeliveryDispatcher;
  readonly retries?: number;
}

export interface AgentJobDeliveryResult {
  readonly delivered: boolean;
  readonly attempts: number;
  readonly outboundId?: string;
  readonly error?: string;
}

/** Deliver a completed AgentJob result back to the originating channel/peer. */
export class AgentJobDelivery {
  private readonly retries: number;

  constructor(private readonly deps: AgentJobDeliveryDeps) {
    this.retries = Math.max(0, deps.retries ?? 0);
  }

  async deliver(params: {
    job: AgentJob;
    snapshot: AgentJobSnapshot;
    text: string;
    runId?: string;
  }): Promise<AgentJobDeliveryResult> {
    const { job, snapshot, text, runId } = params;

    this.deps.registry.appendEvent(
      createAgentJobEvent({
        jobId: job.id,
        runId: runId ?? job.traceId,
        type: "job_delivery_requested",
        payload: { status: snapshot.status },
      }),
    );

    let attempt = 0;
    let lastError: string | undefined;

    while (attempt <= this.retries) {
      attempt += 1;
      try {
        const outboundId = await this.deps.dispatch.send({
          delivery: {
            route: job.route,
            traceId: job.traceId,
            sessionKey: job.sessionKey,
            agentId: job.agentId,
            source: "job",
          },
          replyText: text || snapshot.resultSummary,
        });

        this.deps.registry.appendEvent(
          createAgentJobEvent({
            jobId: job.id,
            runId: runId ?? job.traceId,
            type: "job_delivery_succeeded",
            payload: { attempts: attempt, outboundId },
          }),
        );

        return {
          delivered: true,
          attempts: attempt,
          outboundId,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    this.deps.registry.appendEvent(
      createAgentJobEvent({
        jobId: job.id,
        runId: runId ?? job.traceId,
        type: "job_delivery_failed",
        payload: { attempts: attempt, error: lastError },
      }),
    );

    return {
      delivered: false,
      attempts: attempt,
      error: lastError,
    };
  }
}

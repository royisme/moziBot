import type { AgentJobEvent, AgentJobEventType } from "./types";

/** Create a normalized AgentJob event payload. */
export function createAgentJobEvent(params: {
  jobId: string;
  type: AgentJobEventType;
  runId?: string;
  at?: number;
  payload?: Record<string, unknown>;
}): AgentJobEvent {
  return {
    jobId: params.jobId,
    runId: params.runId,
    type: params.type,
    at: params.at ?? Date.now(),
    payload: params.payload,
  };
}

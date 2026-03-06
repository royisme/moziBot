import type { AgentJobKind, AgentJobSource } from "./types";

export interface AgentJobExecutionContext {
  readonly jobId: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly traceId?: string;
  readonly source: AgentJobSource;
  readonly kind: AgentJobKind;
}

/** Build a minimal execution context for AgentJob-driven prompt runs. */
export function createAgentJobExecutionContext(
  params: AgentJobExecutionContext,
): AgentJobExecutionContext {
  return params;
}

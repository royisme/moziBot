export type AgentJobEscalationTarget = "continuation" | "job";

export interface AgentJobEscalationInput {
  readonly requiresAsyncDelivery?: boolean;
  readonly source?: "continuation" | "tool" | "reminder" | "user" | "system";
  readonly expectedDelayMs?: number;
  readonly longTaskThresholdMs?: number;
  readonly explicitDetached?: boolean;
}

/** Decide whether follow-up work should remain a continuation or escalate to AgentJob. */
export function resolveAgentJobEscalationTarget(
  input: AgentJobEscalationInput,
): AgentJobEscalationTarget {
  const threshold = input.longTaskThresholdMs ?? 15_000;

  if (input.source === "reminder") {
    return "job";
  }
  if (input.explicitDetached) {
    return "job";
  }
  if (input.requiresAsyncDelivery) {
    return "job";
  }
  if ((input.expectedDelayMs ?? 0) > threshold) {
    return "job";
  }
  if (input.source === "tool") {
    return "job";
  }
  return "continuation";
}

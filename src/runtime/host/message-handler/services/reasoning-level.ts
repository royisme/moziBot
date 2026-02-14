import type { ReasoningLevel } from "../../../model/thinking";

export function resolveCurrentReasoningLevel(params: {
  sessionMetadata: { reasoningLevel?: ReasoningLevel } | undefined;
  agentsConfig: Record<string, unknown>;
  agentId: string;
}): ReasoningLevel {
  const { sessionMetadata, agentsConfig, agentId } = params;
  if (sessionMetadata?.reasoningLevel) {
    return sessionMetadata.reasoningLevel;
  }

  const defaults =
    (agentsConfig.defaults as { output?: { reasoningLevel?: ReasoningLevel } } | undefined)
      ?.output || undefined;
  const entry =
    (agentsConfig[agentId] as { output?: { reasoningLevel?: ReasoningLevel } } | undefined)
      ?.output || undefined;
  return entry?.reasoningLevel ?? defaults?.reasoningLevel ?? "off";
}

/**
 * Reasoning and Reply Rendering Policy Pure Functions
 *
 * This module manages how agent outputs (thinking, tool calls) are rendered.
 */

export type ReplyToolCallMode = "off" | "summary";

export interface ReplyRenderOptions {
  readonly showThinking: boolean;
  readonly showToolCalls: ReplyToolCallMode;
}

/**
 * Resolves reply rendering options for a specific agent.
 * Merges agent-specific overrides with system defaults.
 *
 * Behavior Parity:
 * - defaults from config.agents.defaults.output
 * - per-agent overrides from config.agents[agentId].output
 * - showThinking default: false
 * - showToolCalls default: "off"
 */
export function resolveReplyRenderOptionsFromConfig(
  agentId: string,
  configAgents: Record<string, unknown> | undefined,
): ReplyRenderOptions {
  const agents = configAgents || {};

  // Extract defaults
  const defaults = (agents.defaults as { output?: Partial<ReplyRenderOptions> } | undefined)
    ?.output;

  // Extract agent-specific entry
  const entry = (agents[agentId] as { output?: Partial<ReplyRenderOptions> } | undefined)?.output;

  return {
    showThinking: entry?.showThinking ?? defaults?.showThinking ?? false,
    showToolCalls: entry?.showToolCalls ?? defaults?.showToolCalls ?? "off",
  };
}

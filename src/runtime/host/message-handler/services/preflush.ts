import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MoziConfig } from "../../../../config";
import type { ResolvedMemoryPersistenceConfig } from "../../../../memory/backend-config";
import { runFlushWithTimeout } from "../../../../memory/flush-with-timeout";

/**
 * Preflush service for context compaction.
 *
 * Determines whether recent messages can produce a compactable flush summary.
 */

export interface PreflushDeps {
  readonly logger: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  readonly config: MoziConfig; // kept for API compat, unused
}

/**
 * Evaluates preflush readiness with a timeout race.
 */
export async function performMemoryFlush(params: {
  sessionKey: string;
  agentId: string; // kept for API compat, unused
  messages: AgentMessage[];
  persistenceConfig: ResolvedMemoryPersistenceConfig;
  deps: PreflushDeps;
}): Promise<boolean> {
  return runFlushWithTimeout({
    sessionKey: params.sessionKey,
    messages: params.messages,
    config: params.persistenceConfig,
    logger: params.deps.logger,
  });
}

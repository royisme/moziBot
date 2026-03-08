import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MoziConfig } from "../../../../config";
import type { ResolvedMemoryPersistenceConfig } from "../../../../memory/backend-config";
import { runFlushWithTimeout } from "../../../../memory/flush-with-timeout";

export async function flushMemoryWithLifecycle(params: {
  config: MoziConfig; // kept for API compat, unused
  sessionKey: string;
  agentId: string; // kept for API compat, unused
  messages: AgentMessage[];
  persistence: ResolvedMemoryPersistenceConfig;
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
}): Promise<boolean> {
  return runFlushWithTimeout({
    sessionKey: params.sessionKey,
    messages: params.messages,
    config: params.persistence,
    logger: params.logger,
  });
}

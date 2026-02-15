import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MoziConfig } from "../../../../config";
import { getMemoryLifecycleOrchestrator } from "../../../../memory";
import {
  resolveHomeDir,
  type ResolvedMemoryPersistenceConfig,
} from "../../../../memory/backend-config";
import { FlushManager } from "../../../../memory/flush-manager";

interface MemoryFlushLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export async function flushMemoryWithLifecycle(params: {
  config: MoziConfig;
  sessionKey: string;
  agentId: string;
  messages: AgentMessage[];
  persistence: ResolvedMemoryPersistenceConfig;
  logger: MemoryFlushLogger;
}): Promise<boolean> {
  const { config, sessionKey, agentId, messages, persistence, logger } = params;
  const flushManager = new FlushManager(resolveHomeDir(config, agentId));
  try {
    const timeout = persistence.timeoutMs || 1500;
    const result = await Promise.race([
      flushManager.flush({ messages, config: persistence, sessionKey }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Flush timeout")), timeout)),
    ]);
    const success = result === true;
    if (success) {
      const lifecycle = await getMemoryLifecycleOrchestrator(config, agentId);
      await lifecycle.handle({ type: "flush_completed", sessionKey });
    }
    return success;
  } catch (err) {
    logger.warn({ err, sessionKey }, "Memory flush failed or timed out");
    return false;
  }
}

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MoziConfig } from "../../../../config";
import { getMemoryLifecycleOrchestrator } from "../../../../memory";
import {
  resolveHomeDir,
  type ResolvedMemoryPersistenceConfig,
} from "../../../../memory/backend-config";
import { FlushManager } from "../../../../memory/flush-manager";

/**
 * Preflush and Memory Persistence Service
 *
 * Manages the orchestration of persisting messages to long-term memory
 * and notifying the memory lifecycle orchestrator.
 */

export interface PreflushDeps {
  readonly logger: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  readonly config: MoziConfig;
}

/**
 * Persists messages to long-term memory with a timeout race.
 * Preserves monolith flushMemory behavior exactly.
 * Strict typing only, no 'any' or 'as any'.
 */
export async function performMemoryFlush(params: {
  sessionKey: string;
  agentId: string;
  messages: AgentMessage[];
  persistenceConfig: ResolvedMemoryPersistenceConfig;
  deps: PreflushDeps;
}): Promise<boolean> {
  const { sessionKey, agentId, messages, persistenceConfig, deps } = params;

  // Parity: create FlushManager with resolveHomeDir(config, agentId)
  const flushManager = new FlushManager(resolveHomeDir(deps.config, agentId));

  try {
    // Parity: default timeout 1500ms when missing
    const timeout = persistenceConfig.timeoutMs || 1500;

    const result = await Promise.race([
      flushManager.flush({ messages, config: persistenceConfig, sessionKey }),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error("Flush timeout")), timeout),
      ),
    ]);

    const success = result;

    if (success) {
      // Parity: call handle({ type: 'flush_completed', sessionKey })
      const lifecycle = await getMemoryLifecycleOrchestrator(deps.config, agentId);
      await lifecycle.handle({ type: "flush_completed", sessionKey });
    }

    return success;
  } catch (err) {
    // Parity: return false and log warning
    deps.logger.warn(
      { err: err instanceof Error ? err : new Error(String(err)), sessionKey },
      "Memory flush failed or timed out",
    );
    return false;
  }
}

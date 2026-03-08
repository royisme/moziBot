import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ResolvedMemoryPersistenceConfig } from "./backend-config";
import { FlushManager } from "./flush-manager";

export async function runFlushWithTimeout(params: {
  sessionKey: string;
  messages: AgentMessage[];
  config: ResolvedMemoryPersistenceConfig;
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
}): Promise<boolean> {
  const { sessionKey, messages, config, logger } = params;
  const flushManager = new FlushManager();
  try {
    const timeout = config.timeoutMs || 1500;
    const result = await Promise.race([
      flushManager.flush({ messages, config }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Flush timeout")), timeout),
      ),
    ]);
    return result.ready;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err : new Error(String(err)), sessionKey },
      "Memory flush failed or timed out",
    );
    return false;
  }
}

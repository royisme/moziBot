import { randomUUID } from "node:crypto";
import { logger } from "../../../logger";
import type { SessionManager } from "./manager";
import type { EnhancedSubAgentRegistry } from "./subagent-registry";

export { EnhancedSubAgentRegistry as SubAgentRegistry } from "./subagent-registry";

export interface SpawnOptions {
  parentKey: string;
  agentId?: string;
  model?: string;
  task: string;
  label?: string;
  cleanup: "delete" | "keep";
  timeoutSeconds?: number;
  runId?: string;
}

export interface SpawnResult {
  runId: string;
  childKey: string;
  sessionId: string;
  status: "accepted" | "rejected" | "error";
  error?: string;
}


export async function spawnSubAgent(
  sessionManager: SessionManager,
  registry: EnhancedSubAgentRegistry,
  options: SpawnOptions,
): Promise<SpawnResult> {
  try {
    const parentSession = sessionManager.get(options.parentKey);
    if (!parentSession) {
      return {
        runId: options.runId ?? "",
        childKey: "",
        sessionId: "",
        status: "rejected",
        error: "Parent session not found",
      };
    }

    if (parentSession.channel === "subagent") {
      return {
        runId: options.runId ?? "",
        childKey: "",
        sessionId: "",
        status: "rejected",
        error: "Nested subagent spawning is not allowed",
      };
    }

    const agentId = options.agentId || parentSession.agentId;
    const uuid = randomUUID();
    const runId = options.runId ?? `subagent:${randomUUID()}`;
    const childKey = `agent:${agentId}:subagent:dm:${uuid}`;

    await sessionManager.getOrCreate(childKey, {
      agentId,
      channel: "subagent",
      peerId: uuid,
      peerType: "dm",
      parentKey: options.parentKey,
      status: "idle",
      metadata: {
        task: options.task,
        label: options.label,
        model: options.model,
        runId,
        timeoutSeconds: options.timeoutSeconds,
      },
    });

    registry.register({
      runId,
      childKey,
      parentKey: options.parentKey,
      task: options.task,
      label: options.label,
      cleanup: options.cleanup,
      status: "accepted",
      timeoutSeconds: options.timeoutSeconds,
    });

    logger.info({ runId, childKey, parentKey: options.parentKey }, "Spawned subagent session");

    return {
      runId,
      childKey,
      sessionId: childKey,
      status: "accepted",
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: message }, "Failed to spawn subagent");
    return {
      runId: options.runId ?? "",
      childKey: "",
      sessionId: "",
      status: "error",
      error: message,
    };
  }
}

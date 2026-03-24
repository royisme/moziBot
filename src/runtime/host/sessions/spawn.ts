import { randomUUID } from "node:crypto";
import { logger } from "../../../logger";
import type { SessionManager } from "./manager";
import type { DetachedRunRegistry } from "./subagent-registry";

export { DetachedRunRegistry } from "./subagent-registry";

export interface SpawnOptions {
  parentKey: string;
  agentId?: string;
  model?: string;
  task: string;
  label?: string;
  cleanup: "delete" | "keep";
  timeoutSeconds?: number;
  runId?: string;
  /** Visibility policy: defaults to "user_visible" for user-originated detached work */
  visibilityPolicy?: "user_visible" | "internal_silent";
}

export interface SpawnResult {
  runId: string;
  childKey: string;
  sessionId: string;
  status: "accepted" | "rejected" | "error";
  error?: string;
  /** Whether the spawned task is user-visible (owes the user an acknowledgement) */
  isUserVisible: boolean;
  /** Whether the acceptance acknowledgement has been delivered/scheduled */
  ackDelivered: boolean;
}

export async function spawnSubAgent(
  sessionManager: SessionManager,
  registry: DetachedRunRegistry,
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
        isUserVisible: false,
        ackDelivered: false,
      };
    }

    if (parentSession.channel === "subagent") {
      return {
        runId: options.runId ?? "",
        childKey: "",
        sessionId: "",
        status: "rejected",
        error: "Nested subagent spawning is not allowed",
        isUserVisible: false,
        ackDelivered: false,
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
      visibilityPolicy: options.visibilityPolicy ?? "user_visible",
    });

    logger.info({ runId, childKey, parentKey: options.parentKey }, "Spawned subagent session");

    // Check if the task is user-visible and if ack was delivered
    const isUserVisible = options.visibilityPolicy !== "internal_silent";
    const runRecord = registry.get(runId);
    const ackDelivered = runRecord?.ackDelivery?.status === "delivered";

    return {
      runId,
      childKey,
      sessionId: childKey,
      status: "accepted",
      isUserVisible,
      ackDelivered,
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
      isUserVisible: false,
      ackDelivered: false,
    };
  }
}

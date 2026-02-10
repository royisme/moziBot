import { randomUUID } from "node:crypto";
import type { SessionManager } from "./manager";
import { logger } from "../../../logger";

export interface SpawnOptions {
  parentKey: string; // Parent session key
  agentId?: string; // Target agent (default: same as parent)
  model?: string; // Model override
  task: string; // The task/prompt for subagent
  label?: string; // Human-readable label
  cleanup: "delete" | "keep"; // What to do after completion
  timeoutSeconds?: number; // Max runtime
}

export interface SpawnResult {
  childKey: string;
  sessionId: string;
  status: "accepted" | "rejected" | "error";
  error?: string;
}

export interface SubAgentRun {
  childKey: string;
  parentKey: string;
  task: string;
  label?: string;
  cleanup: "delete" | "keep";
  status: "pending" | "running" | "completed" | "failed" | "timeout";
  startedAt: Date;
  completedAt?: Date;
  result?: string;
  error?: string;
}

export class SubAgentRegistry {
  private runs: Map<string, SubAgentRun> = new Map();

  // Register a new subagent run
  register(run: SubAgentRun): void {
    this.runs.set(run.childKey, run);
  }

  // Get run by child key
  get(childKey: string): SubAgentRun | undefined {
    return this.runs.get(childKey);
  }

  // List runs by parent
  listByParent(parentKey: string): SubAgentRun[] {
    return Array.from(this.runs.values()).filter((run) => run.parentKey === parentKey);
  }

  // Update run status
  update(childKey: string, changes: Partial<SubAgentRun>): void {
    const run = this.runs.get(childKey);
    if (run) {
      Object.assign(run, changes);
    }
  }

  // Complete a run (with result or error)
  complete(
    childKey: string,
    result: {
      status: "completed" | "failed" | "timeout";
      result?: string;
      error?: string;
    },
  ): void {
    const run = this.runs.get(childKey);
    if (run) {
      run.status = result.status;
      run.result = result.result;
      run.error = result.error;
      run.completedAt = new Date();
    }
  }

  // Cleanup completed runs based on policy
  cleanup(childKey: string): void {
    const run = this.runs.get(childKey);
    if (run && run.cleanup === "delete") {
      this.runs.delete(childKey);
    }
  }
}

// Spawn a subagent session
export async function spawnSubAgent(
  sessionManager: SessionManager,
  registry: SubAgentRegistry,
  options: SpawnOptions,
): Promise<SpawnResult> {
  try {
    const parentSession = sessionManager.get(options.parentKey);
    if (!parentSession) {
      return {
        childKey: "",
        sessionId: "",
        status: "rejected",
        error: "Parent session not found",
      };
    }

    // Prevent nested spawning (subagent cannot spawn)
    if (parentSession.channel === "subagent") {
      return {
        childKey: "",
        sessionId: "",
        status: "rejected",
        error: "Nested subagent spawning is not allowed",
      };
    }

    const agentId = options.agentId || parentSession.agentId;
    const uuid = randomUUID();
    const childKey = `${agentId}:subagent:dm:${uuid}`;

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
      },
    });

    const run: SubAgentRun = {
      childKey,
      parentKey: options.parentKey,
      task: options.task,
      label: options.label,
      cleanup: options.cleanup,
      status: "pending",
      startedAt: new Date(),
    };

    registry.register(run);

    logger.info(`Spawned subagent session: ${childKey} for parent: ${options.parentKey}`);

    // Note: Async execution (actually running the agent) happens separately
    // as per requirements "Return immediately (async execution happens separately)"

    return {
      childKey,
      sessionId: childKey, // Using childKey as sessionId for now
      status: "accepted",
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to spawn subagent: ${message}`);
    return {
      childKey: "",
      sessionId: "",
      status: "error",
      error: message,
    };
  }
}

import type { AgentConfig } from "../runtime/host/agents/types";
import type { Session } from "../runtime/host/sessions/types";
import { type ContainerConfig, ContainerRuntime } from "../container/runtime";
import { agentEvents } from "../infra/agent-events";
import { logger } from "../logger";

export interface ExecutorConfig {
  containerImage: string;
  containerBackend: "docker" | "apple";
  defaultModel: string;
  apiBaseUrl?: string;
  apiKey?: string;
}

export interface AgentRun {
  id: string;
  sessionKey: string;
  agentId: string;
  containerName: string;
  status: "pending" | "starting" | "running" | "completed" | "failed";
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export class AgentExecutor {
  public runtime: ContainerRuntime;
  private config: ExecutorConfig;
  private runs: Map<string, AgentRun> = new Map();

  constructor(config: ExecutorConfig) {
    this.config = config;
    this.runtime = new ContainerRuntime(config.containerBackend);
  }

  // Start agent for a session
  async start(session: Session, agent: AgentConfig, prompt: string): Promise<AgentRun> {
    const runId = crypto.randomUUID();
    const containerName = `mozi-agent-${runId.slice(0, 8)}`;

    const run: AgentRun = {
      id: runId,
      sessionKey: session.key,
      agentId: agent.id,
      containerName,
      status: "pending",
    };

    this.runs.set(runId, run);

    try {
      run.status = "starting";
      run.startedAt = new Date();

      agentEvents.emitLifecycle({
        runId,
        sessionKey: session.key,
        data: { phase: "start", startedAt: Date.now() },
      });

      // Build container config
      const containerConfig: ContainerConfig = {
        backend: this.config.containerBackend,
        image: this.config.containerImage,
        workdir: "/workspace",
        env: {
          MOZI_SESSION_KEY: session.key,
          MOZI_AGENT_ID: agent.id,
          MOZI_MODEL: agent.model || this.config.defaultModel,
          MOZI_API_BASE: this.config.apiBaseUrl || "",
          MOZI_API_KEY: this.config.apiKey || "",
          MOZI_PROMPT: prompt,
        },
        mounts: [{ source: agent.workspace, target: "/workspace", readonly: false }],
      };

      // Create and start container
      await this.runtime.create(containerName, containerConfig);
      run.status = "running";

      return run;
    } catch (err) {
      const error = (err as Error).message;
      run.status = "failed";
      run.error = error;

      agentEvents.emitLifecycle({
        runId,
        sessionKey: session.key,
        data: {
          phase: "error",
          startedAt: run.startedAt?.getTime(),
          endedAt: Date.now(),
          error,
        },
      });

      throw err;
    }
  }

  // Execute a prompt and wait for response
  async execute(runId: string, prompt: string): Promise<string> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    // Write prompt to container's input
    // Wait for response
    // Return output

    // Placeholder for Task 4.2 as per provided snippet structure
    // In actual implementation this might use runtime.exec or some other mechanism
    logger.info({ runId, prompt }, "Executing prompt in container (placeholder)");
    return "Response placeholder";
  }

  // Stop an agent run
  async stop(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }

    try {
      await this.runtime.stop(run.containerName);
      await this.runtime.remove(run.containerName);
    } catch (err) {
      logger.warn({ err, runId }, "Error during container cleanup");
    } finally {
      run.status = "completed";
      run.completedAt = new Date();

      agentEvents.emitLifecycle({
        runId,
        sessionKey: run.sessionKey,
        data: {
          phase: "end",
          startedAt: run.startedAt?.getTime(),
          endedAt: Date.now(),
        },
      });
    }
  }

  // Get run status
  getRun(runId: string): AgentRun | undefined {
    return this.runs.get(runId);
  }

  // List active runs
  listRuns(sessionKey?: string): AgentRun[] {
    const runs = Array.from(this.runs.values());
    if (sessionKey) {
      return runs.filter((r) => r.sessionKey === sessionKey);
    }
    return runs;
  }

  // Cleanup completed runs
  async cleanup(): Promise<void> {
    for (const [id, run] of this.runs) {
      if (run.status === "completed" || run.status === "failed") {
        this.runs.delete(id);
      }
    }
  }
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MoziConfig } from "../../config/index.js";
import type { EventEnqueuer } from "../core/contracts.js";
import { evaluateRules } from "./classifier/rules.js";
import { parseHeartbeatDirectives } from "./directive-reader.js";
import { WatchdogStateCollector, type WatchdogStateInputs } from "./state-collector.js";
import type { WatchdogReadFacade } from "./watchdog-read-facade.js";

export type WatchdogConfig = {
  intervalMs: number;
  prompt: string;
  enabled: boolean;
};

type WatchdogAgentState = {
  agentId: string;
  homeDir: string;
  nextRunAt: number;
  paused: boolean;
  config: WatchdogConfig;
};

const DEFAULT_WATCHDOG_INTERVAL_MS = 15_000;

export class WatchdogService {
  private agentStates = new Map<string, WatchdogAgentState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stateCollector: WatchdogStateCollector;

  constructor(
    private readonly facade: WatchdogReadFacade,
    private readonly enqueuer: EventEnqueuer,
    stateInputs: WatchdogStateInputs,
    private readonly defaultConfig: WatchdogConfig = {
      intervalMs: DEFAULT_WATCHDOG_INTERVAL_MS,
      prompt: "",
      enabled: true,
    },
  ) {
    this.stateCollector = new WatchdogStateCollector(stateInputs);
  }

  start(config: MoziConfig): void {
    this.updateConfig(config);
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, DEFAULT_WATCHDOG_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.agentStates.clear();
  }

  updateConfig(config: MoziConfig): void {
    const agents = config.agents ?? {};
    const entries = Object.entries(agents).filter(([agentId]) => agentId !== "defaults");

    const next = new Map<string, WatchdogAgentState>();

    for (const [agentId] of entries) {
      const homeDir = this.facade.getHomeDir(agentId);
      if (!homeDir) {
        continue;
      }

      const prev = this.agentStates.get(agentId);
      next.set(agentId, {
        agentId,
        homeDir,
        nextRunAt: prev ? prev.nextRunAt : Date.now(),
        paused: prev?.paused ?? false,
        config: prev?.config ?? { ...this.defaultConfig },
      });
    }

    // If no agents found, try default agent
    if (next.size === 0) {
      const defaultAgentId = resolveDefaultAgentId(agents);
      const homeDir = this.facade.getHomeDir(defaultAgentId);
      if (homeDir) {
        const prev = this.agentStates.get(defaultAgentId);
        next.set(defaultAgentId, {
          agentId: defaultAgentId,
          homeDir,
          nextRunAt: prev ? prev.nextRunAt : Date.now(),
          paused: prev?.paused ?? false,
          config: prev?.config ?? { ...this.defaultConfig },
        });
      }
    }

    this.agentStates = next;
  }

  setPaused(agentId: string, paused: boolean): boolean {
    const state = this.agentStates.get(agentId);
    if (!state) {
      return false;
    }
    state.paused = paused;
    return true;
  }

  isPaused(agentId: string): boolean {
    return this.agentStates.get(agentId)?.paused ?? false;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [, agentState] of this.agentStates) {
      if (agentState.paused) {
        continue;
      }
      if (now < agentState.nextRunAt) {
        continue;
      }
      agentState.nextRunAt = now + agentState.config.intervalMs;
      await this.runWatchdog(agentState);
    }
  }

  private async runWatchdog(agentState: WatchdogAgentState): Promise<void> {
    const { agentId, homeDir } = agentState;

    // 1. Get last route
    const route = this.facade.getLastRoute(agentId);
    if (!route) {
      return;
    }

    // 2. Read HEARTBEAT.md
    let directives = {
      enabled: true,
      intervalMs: null as number | null,
      prompt: null as string | null,
    };
    try {
      const content = await readFile(join(homeDir, "HEARTBEAT.md"), "utf-8");
      directives = parseHeartbeatDirectives(content);
    } catch {
      // File not found — use defaults
    }
    if (!directives.enabled) {
      return;
    }

    // Update interval if overridden by directive
    if (directives.intervalMs !== null) {
      agentState.config.intervalMs = directives.intervalMs;
    }

    // 3. Resolve session key
    const sessionKey = this.facade.resolveSessionKey(agentId, route);

    // 4. Skip if session is active
    if (this.facade.isSessionActive(sessionKey)) {
      return;
    }

    // 5. Collect state
    const watchdogState = this.stateCollector.collect(
      agentId,
      sessionKey,
      directives.prompt ?? undefined,
    );

    // 6. Run rule classifier
    const decision = evaluateRules(watchdogState);
    if (decision === "sleep") {
      return;
    }

    // 7. Enqueue watchdog_wake — do NOT call LLM directly
    const effectivePrompt = directives.prompt ?? agentState.config.prompt;
    await this.enqueuer.enqueueEvent({
      sessionKey,
      eventType: "watchdog_wake",
      payload: { agentId, reason: "timer", prompt: effectivePrompt },
      priority: 10,
    });
  }
}

function resolveDefaultAgentId(agents: MoziConfig["agents"]): string {
  if (!agents) {
    return "mozi";
  }
  const entries = Object.entries(agents).filter(([agentId]) => agentId !== "defaults");
  const mainAgent = entries.find(([, entry]) => (entry as { main?: boolean }).main === true);
  if (mainAgent?.[0]) {
    return mainAgent[0];
  }
  return entries[0]?.[0] || "mozi";
}

import fs from "node:fs/promises";
import path from "node:path";
import type { MoziConfig } from "../../config";
import { setHeartbeatWakeHandler } from "../../infra/heartbeat-wake";
import { drainSystemEvents, peekSystemEventEntries } from "../../infra/system-events";
import { logger } from "../../logger";
import type { InboundMessage } from "../adapters/channels/types";
import type { AgentManager } from "../agent-manager";
import type { MessageHandler } from "./message-handler";
import { normalizeRouteContext } from "./routing/route-context";

const DEFAULT_HEARTBEAT_EVERY = "30m";
const DEFAULT_HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (home context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY.";

const HEARTBEAT_FILENAME = "HEARTBEAT.md";

export type HeartbeatConfig = {
  enabled?: boolean;
  every?: string;
  prompt?: string;
};

type HeartbeatState = {
  agentId: string;
  everyMs: number;
  nextRunAt: number;
  prompt: string;
  paused: boolean;
};

type HeartbeatDirectives = {
  enabled?: boolean;
  everyMs?: number;
  prompt?: string;
};

export class HeartbeatRunner {
  private timer?: ReturnType<typeof setInterval>;
  private states = new Map<string, HeartbeatState>();
  private config?: MoziConfig;

  constructor(
    private handler: MessageHandler,
    private agentManager: AgentManager,
    private enqueueInbound: (message: InboundMessage) => Promise<void>,
  ) {}

  start(config: MoziConfig): void {
    this.updateConfig(config);
    if (this.timer) {
      return;
    }

    // Register as the heartbeat wake handler so external events can trigger runs
    setHeartbeatWakeHandler(async ({ reason, sessionKey }) => {
      return this.handleWake(reason, sessionKey);
    });

    this.timer = setInterval(() => {
      void this.tick();
    }, 15_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  updateConfig(config: MoziConfig): void {
    this.config = config;
    const previous = new Map(this.states);
    const next = new Map<string, HeartbeatState>();
    const agents = config.agents ?? {};
    const defaults = (agents.defaults as { heartbeat?: HeartbeatConfig } | undefined)?.heartbeat;
    const entries = Object.entries(agents).filter(([agentId]) => agentId !== "defaults");
    const hasExplicitAgents = entries.some(([, entry]) => {
      return Boolean((entry as { heartbeat?: HeartbeatConfig }).heartbeat);
    });
    const defaultAgentId = resolveDefaultAgentId(agents);
    for (const [agentId, entry] of entries) {
      const entryHeartbeat = (entry as { heartbeat?: HeartbeatConfig }).heartbeat;
      if (hasExplicitAgents && !entryHeartbeat) {
        continue;
      }
      if (!hasExplicitAgents && agentId !== defaultAgentId) {
        continue;
      }
      const cfg = this.mergeHeartbeatConfig(defaults, entryHeartbeat);
      if (!cfg?.enabled) {
        continue;
      }
      const everyMs = parseEveryMs(cfg.every ?? DEFAULT_HEARTBEAT_EVERY);
      if (!everyMs) {
        continue;
      }
      const prompt = cfg.prompt?.trim() || DEFAULT_HEARTBEAT_PROMPT;
      const prev = previous.get(agentId);
      next.set(agentId, {
        agentId,
        everyMs,
        nextRunAt: prev ? prev.nextRunAt : Date.now() + everyMs,
        prompt,
        paused: prev?.paused ?? false,
      });
    }
    this.states = next;
  }

  setPaused(agentId: string, paused: boolean): boolean {
    const state = this.states.get(agentId);
    if (!state) {
      return false;
    }
    state.paused = paused;
    if (!paused) {
      state.nextRunAt = Date.now() + state.everyMs;
    }
    return true;
  }

  isPaused(agentId: string): boolean {
    return this.states.get(agentId)?.paused ?? false;
  }

  private async handleWake(reason: string, sessionKey?: string): Promise<"ok" | "skipped"> {
    if (!this.config) {
      return "skipped";
    }

    // If a sessionKey is specified, try to find the matching state by running
    // a reverse lookup through all heartbeat states.
    for (const state of this.states.values()) {
      if (state.paused) {
        continue;
      }

      const lastRoute = this.handler.getLastRoute(state.agentId);
      if (!lastRoute) {
        continue;
      }

      const route = normalizeRouteContext(lastRoute);
      // Build a temporary base message to resolve the session context
      const baseMessage: InboundMessage = {
        id: `wake-${Date.now()}`,
        channel: route.channelId,
        peerId: route.peerId,
        peerType: route.peerType,
        accountId: route.accountId,
        threadId: route.threadId,
        senderId: "heartbeat-wake",
        senderName: "HeartbeatWake",
        text: "",
        timestamp: new Date(),
        raw: { source: "heartbeat-wake", reason, route },
      };

      const context = this.handler.resolveSessionContext(baseMessage);

      // Match by sessionKey if specified
      if (sessionKey && context.sessionKey !== sessionKey) {
        continue;
      }

      if (this.handler.isSessionActive(context.sessionKey)) {
        logger.debug(
          { reason, sessionKey: context.sessionKey, agentId: state.agentId },
          "Heartbeat wake skipped: session active",
        );
        return "skipped";
      }

      await this.runHeartbeat(state);
      return "ok";
    }

    return "skipped";
  }

  private mergeHeartbeatConfig(
    defaults?: HeartbeatConfig,
    override?: HeartbeatConfig,
  ): HeartbeatConfig | undefined {
    if (!defaults && !override) {
      return undefined;
    }
    return {
      ...defaults,
      ...override,
    };
  }

  private async tick(): Promise<void> {
    if (!this.config) {
      return;
    }
    const now = Date.now();
    for (const state of this.states.values()) {
      if (state.paused) {
        continue;
      }
      if (now < state.nextRunAt) {
        continue;
      }
      await this.runHeartbeat(state);
      state.nextRunAt = Date.now() + state.everyMs;
    }
  }

  private async runHeartbeat(state: HeartbeatState): Promise<void> {
    const lastRoute = this.handler.getLastRoute(state.agentId);
    if (!lastRoute) {
      return;
    }
    const homeDir = this.agentManager.getHomeDir(state.agentId);
    if (!homeDir) {
      return;
    }

    const heartbeatPath = path.join(homeDir, HEARTBEAT_FILENAME);
    let content = "";
    let heartbeatFileExists = true;
    try {
      content = await fs.readFile(heartbeatPath, "utf-8");
    } catch {
      heartbeatFileExists = false;
    }

    const directives = heartbeatFileExists ? parseHeartbeatDirectives(content) : {};
    if (directives.enabled === false) {
      return;
    }
    if (typeof directives.everyMs === "number" && directives.everyMs > 0) {
      state.everyMs = directives.everyMs;
    }
    const effectivePrompt = directives.prompt?.trim() || state.prompt;

    const route = normalizeRouteContext(lastRoute);
    const baseMessage: InboundMessage = {
      id: `heartbeat-${Date.now()}`,
      channel: route.channelId,
      peerId: route.peerId,
      peerType: route.peerType,
      accountId: route.accountId,
      threadId: route.threadId,
      senderId: "heartbeat",
      senderName: "Heartbeat",
      text: "",
      timestamp: new Date(),
      raw: { source: "heartbeat", route },
    };

    const context = this.handler.resolveSessionContext(baseMessage);

    // Peek (do not drain yet) so we can bail out safely if session becomes active
    const events = peekSystemEventEntries(context.sessionKey);

    // Skip if both heartbeat content is empty AND no system events
    if (isHeartbeatContentEffectivelyEmpty(content) && events.length === 0) {
      return;
    }

    const timestamps = this.handler.getSessionTimestamps(context.sessionKey);
    const heartbeatContext = buildHeartbeatContext(timestamps);

    // Build system events section
    const eventLines =
      events.length > 0
        ? [
            "SYSTEM_EVENTS_BEGIN",
            ...events.map((e) => `[${new Date(e.ts).toISOString()}] ${e.text}`),
            "SYSTEM_EVENTS_END",
            "",
          ]
        : [];

    const heartbeatPrompt = [
      effectivePrompt,
      "",
      ...heartbeatContext,
      ...eventLines,
      "HEARTBEAT_FILE_BEGIN",
      content.trim(),
      "HEARTBEAT_FILE_END",
    ]
      .filter((line) => line.length > 0)
      .join("\n");

    const inbound: InboundMessage = {
      ...baseMessage,
      text: heartbeatPrompt,
    };

    // Check session active BEFORE draining — if busy, leave events in queue for next run
    if (this.handler.isSessionActive(context.sessionKey)) {
      logger.info(
        {
          sessionKey: context.sessionKey,
          agentId: state.agentId,
          peerId: inbound.peerId,
        },
        "Heartbeat skipped because session has an active prompt run",
      );
      return;
    }

    // Session is idle — now safe to drain events and enqueue the turn
    drainSystemEvents(context.sessionKey);

    try {
      await this.enqueueInbound(inbound);
    } catch (error) {
      logger.warn({ error, agentId: state.agentId }, "Heartbeat run failed");
    }
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

function parseEveryMs(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }
  const match = /^([0-9]+)\s*(ms|s|m|h|d)$/.exec(value);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2];
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * (multipliers[unit] || 0);
}

export function parseHeartbeatEveryMs(raw: string): number | null {
  return parseEveryMs(raw);
}

function isHeartbeatContentEffectivelyEmpty(content: string | undefined | null): boolean {
  if (content === undefined || content === null) {
    return true;
  }
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^#+(\s|$)/.test(trimmed)) {
      continue;
    }
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue;
    }
    if (/^@heartbeat\b/i.test(trimmed)) {
      continue;
    }
    return false;
  }
  return true;
}

function parseHeartbeatDirectives(content: string): HeartbeatDirectives {
  const directives: HeartbeatDirectives = {};
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const enableMatch = trimmed.match(/^@heartbeat\s+enabled\s*=\s*(on|off|true|false)$/i);
    if (enableMatch) {
      const value = enableMatch[1]?.toLowerCase();
      directives.enabled = value === "on" || value === "true";
      continue;
    }

    const everyMatch = trimmed.match(/^@heartbeat\s+every\s*=\s*([^\s#]+)$/i);
    if (everyMatch) {
      const parsed = parseEveryMs((everyMatch[1] || "").trim());
      if (parsed && parsed > 0) {
        directives.everyMs = parsed;
      }
      continue;
    }

    const promptMatch = trimmed.match(/^@heartbeat\s+prompt\s*=\s*(.+)$/i);
    if (promptMatch) {
      const prompt = (promptMatch[1] || "").trim();
      if (prompt) {
        directives.prompt = prompt;
      }
      continue;
    }
  }
  return directives;
}

function buildHeartbeatContext(
  timestamps: { createdAt?: number; updatedAt?: number } | null,
): string[] {
  const lastActivityMs = timestamps?.updatedAt ?? timestamps?.createdAt;
  const lines = ["HEARTBEAT_CONTEXT_BEGIN"];
  if (typeof lastActivityMs === "number") {
    lines.push(`SESSION_LAST_ACTIVITY_MS=${lastActivityMs}`);
    lines.push(`SESSION_LAST_ACTIVITY_ISO=${new Date(lastActivityMs).toISOString()}`);
  } else {
    lines.push("SESSION_LAST_ACTIVITY_MS=unknown");
  }
  lines.push("HEARTBEAT_CONTEXT_END");
  return lines;
}

import fs from "node:fs/promises";
import path from "node:path";
import type { MoziConfig } from "../../config";
import type { ChannelRegistry } from "../adapters/channels/registry";
import type { InboundMessage } from "../adapters/channels/types";
import type { AgentManager } from "../agent-manager";
import type { MessageHandler } from "./message-handler";
import { logger } from "../../logger";

const DEFAULT_HEARTBEAT_EVERY = "30m";
const DEFAULT_HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";

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
};

export class HeartbeatRunner {
  private timer?: Timer;
  private states = new Map<string, HeartbeatState>();
  private config?: MoziConfig;

  constructor(
    private handler: MessageHandler,
    private agentManager: AgentManager,
    private channels: ChannelRegistry,
  ) {}

  start(config: MoziConfig): void {
    this.updateConfig(config);
    if (this.timer) {
      return;
    }
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
    this.states.clear();
    const agents = config.agents ?? {};
    const defaults = (agents.defaults as { heartbeat?: HeartbeatConfig } | undefined)?.heartbeat;
    for (const [agentId, entry] of Object.entries(agents)) {
      if (agentId === "defaults") {
        continue;
      }
      const cfg = this.mergeHeartbeatConfig(
        defaults,
        (entry as { heartbeat?: HeartbeatConfig }).heartbeat,
      );
      if (!cfg?.enabled) {
        continue;
      }
      const everyMs = parseEveryMs(cfg.every ?? DEFAULT_HEARTBEAT_EVERY);
      if (!everyMs) {
        continue;
      }
      const prompt = cfg.prompt?.trim() || DEFAULT_HEARTBEAT_PROMPT;
      this.states.set(agentId, {
        agentId,
        everyMs,
        nextRunAt: Date.now() + everyMs,
        prompt,
      });
    }
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
      if (now < state.nextRunAt) {
        continue;
      }
      state.nextRunAt = now + state.everyMs;
      await this.runHeartbeat(state);
    }
  }

  private async runHeartbeat(state: HeartbeatState): Promise<void> {
    const lastRoute = this.handler.getLastRoute(state.agentId);
    if (!lastRoute) {
      return;
    }
    const workspaceDir = this.agentManager.getWorkspaceDir(state.agentId);
    if (!workspaceDir) {
      return;
    }

    const heartbeatPath = path.join(workspaceDir, HEARTBEAT_FILENAME);
    let content = "";
    try {
      content = await fs.readFile(heartbeatPath, "utf-8");
    } catch {
      return;
    }

    if (isHeartbeatContentEffectivelyEmpty(content)) {
      return;
    }

    const channel = this.channels.get(lastRoute.channelId);
    if (!channel) {
      return;
    }

    const inbound: InboundMessage = {
      id: `heartbeat-${Date.now()}`,
      channel: lastRoute.channelId,
      peerId: lastRoute.peerId,
      peerType: lastRoute.peerType,
      accountId: lastRoute.accountId,
      threadId: lastRoute.threadId,
      senderId: "heartbeat",
      senderName: "Heartbeat",
      text: state.prompt,
      timestamp: new Date(),
      raw: { source: "heartbeat" },
    };

    try {
      await this.handler.handle(inbound, channel);
    } catch (error) {
      logger.warn({ error, agentId: state.agentId }, "Heartbeat run failed");
    }
  }
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
    return false;
  }
  return true;
}

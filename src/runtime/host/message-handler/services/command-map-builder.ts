import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentManager } from "../../..";
import type { ModelRegistry } from "../../..";
import type { MoziConfig } from "../../../../config";
import type { ResolvedMemoryPersistenceConfig } from "../../../../memory/backend-config";
import type { ChannelPlugin } from "../../../adapters/channels/plugin";
import type { CommandHandlerMap } from "./command-handlers";
import { handleReasoningCommand, handleThinkCommand } from "../../commands/reasoning";
import {
  handleWhoamiCommand as handleWhoamiCommandService,
  handleStatusCommand as handleStatusCommandService,
  handleContextCommand as handleContextCommandService,
} from "../../commands/session";
import { renderAssistantReply } from "../../reply-utils";
import { handleAuthCommand as handleAuthCommandService } from "./auth-command";
import { createMessageCommandHandlerMap } from "./command-map";
import { toError as toErrorService } from "./error-utils";
import { handleHeartbeatCommand as handleHeartbeatCommandService } from "./heartbeat-command";
import {
  handleModelsCommand as handleModelsCommandService,
  handleSwitchCommand as handleSwitchCommandService,
} from "./models-command";
import { resolveCurrentReasoningLevel as resolveCurrentReasoningLevelService } from "./reasoning-level";
import { handleRemindersCommand as handleRemindersCommandService } from "./reminders-command";
import {
  handleCompactCommand as handleCompactCommandService,
  handleNewSessionCommand as handleNewSessionCommandService,
  handleRestartCommand as handleRestartCommandService,
} from "./session-control-command";

export function buildCommandHandlerMap(params: {
  channel: ChannelPlugin;
  agentManager: AgentManager;
  modelRegistry: ModelRegistry;
  config: MoziConfig;
  runtimeControl?: {
    getStatus?: () => { running: boolean; pid: number | null; uptime: number };
    restart?: () => Promise<void> | void;
  };
  logger: {
    warn(obj: Record<string, unknown>, msg: string): void;
    info?(obj: Record<string, unknown>, msg: string): void;
    debug?(obj: Record<string, unknown>, msg: string): void;
  };
  getVersion: () => string;
  flushMemory: (
    sessionKey: string,
    agentId: string,
    messages: AgentMessage[],
    config: ResolvedMemoryPersistenceConfig,
  ) => Promise<boolean>;
  interruptSession: (sessionKey: string, reason?: string) => Promise<boolean>;
  resolveWorkspaceDir: (agentId: string) => string | null;
}): CommandHandlerMap {
  const {
    channel,
    agentManager,
    modelRegistry,
    config,
    runtimeControl,
    logger,
    getVersion,
    flushMemory,
    interruptSession,
    resolveWorkspaceDir,
  } = params;

  return createMessageCommandHandlerMap({
    channel,
    deps: {
      onWhoami: async ({ message, channel, peerId }) => {
        await handleWhoamiCommandService({ message, channel, peerId });
      },
      onStatus: async ({ sessionKey, agentId, message, channel, peerId }) => {
        await handleStatusCommandService({
          sessionKey,
          agentId,
          message,
          channel,
          peerId,
          agentManager,
          runtimeControl,
          resolveCurrentReasoningLevel: (targetSessionKey, targetAgentId) =>
            resolveCurrentReasoningLevelService({
              sessionMetadata: agentManager.getSessionMetadata(targetSessionKey) as
                | { reasoningLevel?: "off" | "on" | "stream" }
                | undefined,
              agentsConfig: (config.agents || {}) as Record<string, unknown>,
              agentId: targetAgentId,
            }),
          version: getVersion(),
        });
      },
      onNew: async ({ sessionKey, agentId, channel, peerId }) => {
        await handleNewSessionCommandService({
          sessionKey,
          agentId,
          channel,
          peerId,
          config,
          agentManager,
          flushMemory,
          runResetGreetingTurn: async ({ sessionKey, agentId }) => {
            const { agent } = await agentManager.getAgent(sessionKey, agentId, {
              promptMode: "reset-greeting",
            });
            const resetPrompt =
              "A new session was started via /new. Greet the user in your configured persona in 1-2 short sentences. Follow language and tone rules from SOUL.md / IDENTITY.md / USER.md (if they specify Chinese, reply in Chinese). Ask what they want to work on now.";
            await agent.prompt(resetPrompt);
            const latest = agent.messages.at(-1);
            const reply = latest
              ? renderAssistantReply((latest as { content?: unknown }).content)
              : "";
            const genericPi =
              /(^|\n|\s)(i\s*am\s*pi|i\s*'m\s*pi|我是\s*pi|我是\s*Pi)(\b|\s|[，。,.!！?？])/i;
            if (genericPi.test(reply.trim())) {
              return "我会按照你在 IDENTITY.md / SOUL.md 中定义的身份工作。你现在想先做什么？";
            }
            return reply || null;
          },
        });
      },
      onModels: async ({ sessionKey, agentId, channel, peerId }) => {
        await handleModelsCommandService({
          sessionKey,
          agentId,
          channel,
          peerId,
          agentManager,
          modelRegistry,
        });
      },
      onSwitch: async ({ sessionKey, agentId, args, channel, peerId }) => {
        await handleSwitchCommandService({
          sessionKey,
          agentId,
          args,
          channel,
          peerId,
          agentManager,
          modelRegistry,
        });
      },
      onStop: async ({ sessionKey, channel, peerId }) => {
        const interrupted = await interruptSession(sessionKey, "Stopped by /stop command");
        await channel.send(peerId, {
          text: interrupted
            ? "Stopped active run. You can now /switch and continue."
            : "No active run to stop.",
        });
      },
      onRestart: async ({ channel, peerId }) => {
        await handleRestartCommandService({ channel, peerId, runtimeControl });
      },
      onCompact: async ({ sessionKey, agentId, channel, peerId }) => {
        await handleCompactCommandService({
          sessionKey,
          agentId,
          channel,
          peerId,
          agentManager,
        });
      },
      onContext: async ({ sessionKey, agentId, channel, peerId }) => {
        await handleContextCommandService({
          sessionKey,
          agentId,
          channel,
          peerId,
          config,
          agentManager,
        });
      },
      onThink: async ({ sessionKey, agentId, channel, peerId, args }) => {
        await handleThinkCommand({
          agentManager,
          sessionKey,
          agentId,
          channel,
          peerId,
          args,
        });
      },
      onReasoning: async ({ sessionKey, channel, peerId, args }) => {
        await handleReasoningCommand({
          agentManager,
          sessionKey,
          channel,
          peerId,
          args,
        });
      },
      onAuth: async ({ action, agentId, message, channel, peerId, args }) => {
        await handleAuthCommandService({
          args: `${action} ${args}`.trim(),
          agentId,
          senderId: message.senderId,
          channel,
          peerId,
          config,
          toError: (error) => toErrorService(error),
        });
      },
      onReminders: async ({ sessionKey, message, channel, peerId, args }) => {
        await handleRemindersCommandService({ sessionKey, message, channel, peerId, args });
      },
      onHeartbeat: async ({ agentId, channel, peerId, args }) => {
        await handleHeartbeatCommandService({
          agentId,
          channel,
          peerId,
          args,
          resolveWorkspaceDir,
          logger,
          toError: (error) => toErrorService(error),
        });
      },
    },
  });
}

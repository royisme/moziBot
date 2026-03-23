import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentManager } from "../../..";
import type { ModelRegistry } from "../../..";
import type { MoziConfig } from "../../../../config";
import type { ResolvedMemoryPersistenceConfig } from "../../../../memory/backend-config";
import type { ChannelPlugin } from "../../../adapters/channels/plugin";
import type { InboundMessage } from "../../../adapters/channels/types";
import { handleReasoningCommand, handleThinkCommand } from "../../commands/reasoning";
import {
  handleWhoamiCommand as handleWhoamiCommandService,
  handleStatusCommand as handleStatusCommandService,
  handleContextCommand as handleContextCommandService,
  handlePromptDigestCommand as handlePromptDigestCommandService,
  handleAcpCommand as handleAcpCommandService,
} from "../../commands/session";
import { renderAssistantReply } from "../../reply-utils";
import { handleAuthCommand as handleAuthCommandService } from "./auth-command";
import type { CommandHandlerMap } from "./command-handlers";
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
  extractIdentityLanguageHintFromSystemPrompt,
  selectNewSessionFallbackText,
} from "./reset-greeting-language";
import { RESET_SESSION_GREETING_PROMPT } from "./reset-greeting-prompt";
import {
  handleCompactCommand as handleCompactCommandService,
  handleNewSessionCommand as handleNewSessionCommandService,
  handleRestartCommand as handleRestartCommandService,
  performSessionReset,
} from "./session-control-command";
import { handleSkillsCommand as handleSkillsCommandService } from "./skills-command";
import { handleTasksCommand as handleTasksCommandService } from "./tasks-command";
import { TasksControlPlane } from "./tasks-control-plane";

const RESET_GREETING_TIMEOUT_MS = 12_000;

type PromptMode = "main" | "reset-greeting" | "subagent-minimal";

export function buildCommandHandlerMap(params: {
  channel: ChannelPlugin;
  agentManager: AgentManager;
  modelRegistry: ModelRegistry;
  config: MoziConfig;
  sessionManager?: import("../../sessions/manager").SessionManager;
  detachedRunRegistry?: import("../../sessions/spawn").DetachedRunRegistry;
  runLifecycleRegistry?: import("./run-lifecycle-registry").RunLifecycleRegistry;
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
  runPromptWithFallback: (params: {
    sessionKey: string;
    agentId: string;
    text: string;
    traceId?: string;
    promptMode?: PromptMode;
    onStream?: (event: {
      type: "text_delta" | "tool_start" | "tool_end" | "agent_end";
      delta?: string;
      toolName?: string;
      toolCallId?: string;
      isError?: boolean;
      fullText?: string;
    }) => void | Promise<void>;
    onFallback?: (info: {
      fromModel: string;
      toModel: string;
      attempt: number;
      error: string;
    }) => Promise<void> | void;
  }) => Promise<void>;
  resolveHomeDir: (agentId: string) => string | null;
}): CommandHandlerMap {
  const {
    channel,
    agentManager,
    modelRegistry,
    config,
    sessionManager,
    detachedRunRegistry,
    runLifecycleRegistry,
    runtimeControl,
    logger,
    getVersion,
    flushMemory,
    interruptSession,
    runPromptWithFallback,
    resolveHomeDir,
  } = params;

  const runPromptAndCaptureReply = async (runParams: {
    sessionKey: string;
    agentId: string;
    text: string;
    promptMode?: PromptMode;
    traceId: string;
    timeoutMs?: number;
    suppressErrors?: boolean;
  }): Promise<string | null> => {
    const { sessionKey, agentId, text, promptMode, traceId, timeoutMs, suppressErrors } = runParams;
    const run = runPromptWithFallback({ sessionKey, agentId, text, traceId, promptMode });

    let timedOut = false;
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(true), timeoutMs);
      });
      try {
        timedOut = await Promise.race([run.then(() => false), timeoutPromise]);
      } catch (error) {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (suppressErrors) {
          logger.warn?.(
            {
              sessionKey,
              agentId,
              traceId,
              error,
            },
            "Reset greeting prompt failed",
          );
          return null;
        }
        throw error;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (timedOut) {
        void run.catch(() => undefined);
        await interruptSession(sessionKey, "Reset greeting prompt timeout");
        return null;
      }
    } else {
      try {
        await run;
      } catch (error) {
        if (suppressErrors) {
          logger.warn?.(
            {
              sessionKey,
              agentId,
              traceId,
              error,
            },
            "Reset greeting prompt failed",
          );
          return null;
        }
        throw error;
      }
    }

    const agentOptions = promptMode ? { promptMode } : undefined;
    const { agent } = await agentManager.getAgent(sessionKey, agentId, agentOptions);
    const latest = agent.messages.at(-1);
    const reply = latest ? renderAssistantReply((latest as { content?: unknown }).content) : "";
    return reply?.trim() ? reply.trim() : null;
  };

  const runResetGreeting = async (resetParams: {
    sessionKey: string;
    agentId: string;
    action: "new" | "reset";
  }): Promise<{ text: string | null; identityLanguageHint: string | null }> => {
    const { sessionKey, agentId, action } = resetParams;
    const { systemPrompt } = await agentManager.getAgent(sessionKey, agentId, {
      promptMode: "reset-greeting",
    });
    const identityLanguageHint = extractIdentityLanguageHintFromSystemPrompt(systemPrompt);
    const reply = await runPromptAndCaptureReply({
      sessionKey,
      agentId,
      text: RESET_SESSION_GREETING_PROMPT,
      promptMode: "reset-greeting",
      traceId: `command:${action}:reset-greeting:${Date.now()}`,
      timeoutMs: RESET_GREETING_TIMEOUT_MS,
      suppressErrors: true,
    });
    return { text: reply, identityLanguageHint };
  };

  const handleSessionReset = async (sessionParams: {
    sessionKey: string;
    agentId: string;
    message: InboundMessage;
    channel: ChannelPlugin;
    peerId: string;
    action: "new" | "reset";
    args: string;
  }): Promise<void> => {
    const {
      sessionKey: sk,
      agentId: agId,
      message,
      channel: msgChannel,
      peerId,
      action,
      args,
    } = sessionParams;
    const trimmedArgs = args.trim();
    const ensureMainPrompt = async () => {
      try {
        await agentManager.ensureChannelContext({
          sessionKey: sk,
          agentId: agId,
          message,
          channel: msgChannel,
          promptModeOverride: "main",
        });
      } catch (error) {
        logger.warn?.(
          { sessionKey: sk, agentId: agId, error },
          "Failed to rebuild main prompt after session reset",
        );
      }
    };
    if (trimmedArgs) {
      await performSessionReset({
        sessionKey: sk,
        agentId: agId,
        config,
        agentManager,
        flushMemory,
        logger,
        reason: action,
      });
      await ensureMainPrompt();

      const reply = await runPromptAndCaptureReply({
        sessionKey: sk,
        agentId: agId,
        text: trimmedArgs,
        promptMode: "main",
        traceId: `command:${action}:followup:${Date.now()}`,
      });
      if (reply) {
        await msgChannel.send(peerId, { text: reply });
        return;
      }
      await msgChannel.send(peerId, {
        text: selectNewSessionFallbackText(null),
      });
      return;
    }

    await handleNewSessionCommandService({
      sessionKey: sk,
      agentId: agId,
      channel: msgChannel,
      peerId,
      config,
      agentManager,
      flushMemory,
      logger,
      reason: action,
      runResetGreetingTurn: async ({ sessionKey: nestedSk, agentId: nestedAgId }) =>
        await runResetGreeting({ sessionKey: nestedSk, agentId: nestedAgId, action }),
    });
    await ensureMainPrompt();
  };

  return createMessageCommandHandlerMap({
    channel,
    deps: {
      onWhoami: async ({ message, channel: msgChannel, peerId }) => {
        await handleWhoamiCommandService({ message, channel: msgChannel, peerId });
      },
      onStatus: async ({ sessionKey, agentId, message, channel: msgChannel, peerId }) => {
        await handleStatusCommandService({
          sessionKey,
          agentId,
          message,
          channel: msgChannel,
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
      onPromptDigest: async ({ sessionKey, agentId, channel: msgChannel, peerId }) => {
        await handlePromptDigestCommandService({
          sessionKey,
          agentId,
          channel: msgChannel,
          peerId,
          agentManager,
        });
      },
      onNew: async ({ sessionKey, agentId, message, channel: msgChannel, peerId, args }) => {
        await handleSessionReset({
          sessionKey,
          agentId,
          message,
          channel: msgChannel,
          peerId,
          action: "new",
          args,
        });
      },
      onReset: async ({ sessionKey, agentId, message, channel: msgChannel, peerId, args }) => {
        await handleSessionReset({
          sessionKey,
          agentId,
          message,
          channel: msgChannel,
          peerId,
          action: "reset",
          args,
        });
      },
      onModels: async ({ sessionKey, agentId, channel: msgChannel, peerId }) => {
        await handleModelsCommandService({
          sessionKey,
          agentId,
          channel: msgChannel,
          peerId,
          agentManager,
          modelRegistry,
        });
      },
      onTasks: async ({ sessionKey, args, channel: msgChannel, peerId }) => {
        if (!sessionManager || !detachedRunRegistry) {
          await msgChannel.send(peerId, { text: "Task controls are unavailable in this runtime." });
          return;
        }
        await handleTasksCommandService({
          sessionKey,
          args,
          channel: msgChannel,
          peerId,
          controlPlane: new TasksControlPlane(detachedRunRegistry, runLifecycleRegistry),
        });
      },
      onSkills: async ({ agentId, channel: msgChannel, peerId }) => {
        await handleSkillsCommandService({
          agentId,
          channel: msgChannel,
          peerId,
          agentManager,
        });
      },
      onSwitch: async ({ sessionKey, agentId, args, channel: msgChannel, peerId }) => {
        await handleSwitchCommandService({
          sessionKey,
          agentId,
          args,
          channel: msgChannel,
          peerId,
          agentManager,
          modelRegistry,
        });
      },
      onStop: async ({ sessionKey, channel: msgChannel, peerId }) => {
        const interrupted = await interruptSession(sessionKey, "Stopped by /stop command");
        await msgChannel.send(peerId, {
          text: interrupted
            ? "Stopped active run. You can now /switch and continue."
            : "No active run to stop.",
        });
      },
      onRestart: async ({ channel: msgChannel, peerId }) => {
        await handleRestartCommandService({ channel: msgChannel, peerId, runtimeControl });
      },
      onCompact: async ({ sessionKey, agentId, channel: msgChannel, peerId }) => {
        await handleCompactCommandService({
          sessionKey,
          agentId,
          channel: msgChannel,
          peerId,
          agentManager,
        });
      },
      onContext: async ({ sessionKey, agentId, channel: msgChannel, peerId }) => {
        await handleContextCommandService({
          sessionKey,
          agentId,
          channel: msgChannel,
          peerId,
          config,
          agentManager,
        });
      },
      onThink: async ({ sessionKey, agentId, channel: msgChannel, peerId, args }) => {
        await handleThinkCommand({
          agentManager,
          sessionKey,
          agentId,
          channel: msgChannel,
          peerId,
          args,
        });
      },
      onReasoning: async ({ sessionKey, channel: msgChannel, peerId, args }) => {
        await handleReasoningCommand({
          agentManager,
          sessionKey,
          channel: msgChannel,
          peerId,
          args,
        });
      },
      onAuth: async ({ action, agentId, message, channel: msgChannel, peerId, args }) => {
        await handleAuthCommandService({
          args: `${action} ${args}`.trim(),
          agentId,
          senderId: message.senderId,
          channel: msgChannel,
          peerId,
          config,
          toError: (error) => toErrorService(error),
        });
      },
      onReminders: async ({ sessionKey, message, channel: msgChannel, peerId, args }) => {
        await handleRemindersCommandService({
          sessionKey,
          message,
          channel: msgChannel,
          peerId,
          args,
        });
      },
      onHeartbeat: async ({ agentId, channel: msgChannel, peerId, args }) => {
        await handleHeartbeatCommandService({
          agentId,
          channel: msgChannel,
          peerId,
          args,
          resolveHomeDir,
          logger,
          toError: (error) => toErrorService(error),
        });
      },
      onAcp: async ({ sessionKey, agentId, message, channel: msgChannel, peerId, args }) => {
        await handleAcpCommandService({
          sessionKey,
          agentId,
          message,
          channel: msgChannel,
          peerId,
          args,
          config,
        });
      },
      onReload: async ({ sessionKey, agentId, message, channel: msgChannel, peerId }) => {
        agentManager.invalidateBasePromptCache(sessionKey);
        await agentManager.ensureChannelContext({
          sessionKey,
          agentId,
          message,
          channel: msgChannel,
        });
        const metadata = agentManager.getPromptMetadata(sessionKey);
        const loadedNames = metadata?.loadedFiles.map((f) => f.name).join(", ") ?? "none";
        await msgChannel.send(peerId, {
          text: `Prompt reloaded. Loaded files: ${loadedNames}`,
        });
      },
    },
  });
}

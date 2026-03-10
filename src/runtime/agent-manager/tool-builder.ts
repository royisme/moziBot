import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { SkillLoader } from "../../agents/skills/loader";
import type { MoziConfig } from "../../config";
import type { ExtensionRegistry } from "../../extensions";
import { logger } from "../../logger";
import { getMemoryManager, getMemoryLifecycleOrchestrator } from "../../memory";
import type { MemorySearchManager } from "../../memory/types";
import { createRuntimeSecretBroker } from "../auth/broker";
import { type AuthResolver, type ExecRuntime } from "../exec-runtime";
import { createExecTool } from "../exec-tool";
import { getRuntimeHookRunner } from "../hooks";
import type { SandboxConfig } from "../sandbox/types";
import { sanitizeTools } from "../schema-sanitizer";
import { createSkillsNoteTool } from "../skills-note";
import type { SubagentRegistry } from "../subagent-registry";
import { filterTools } from "../tool-selection";
import {
  createMemoryTools,
  createPiCodingTools,
  createProcessTools,
  createSubagentTool,
} from "../tools";
import type { ModelSpec } from "../types";
import type { AgentEntry } from "./config-resolver";
import {
  resolveToolAllowList,
  resolveExecAllowlist,
  resolveExecAllowedSecrets,
} from "./config-resolver";

export interface BuildToolsParams {
  sessionKey: string;
  agentId: string;
  entry?: AgentEntry;
  workspaceDir: string;
  homeDir: string;
  sandboxConfig?: SandboxConfig;
  modelSpec: ModelSpec;
}

export interface BuildToolsDeps {
  config: MoziConfig;
  subagents?: SubagentRegistry;
  skillLoader?: SkillLoader;
  extensionRegistry: ExtensionRegistry;
  toolProvider?: (params: {
    sessionKey: string;
    agentId: string;
    workspaceDir: string;
    homeDir: string;
    sandboxConfig?: SandboxConfig;
  }) => Promise<AgentTool[]> | AgentTool[];
  getExecRuntime: (params: {
    workspaceDir: string;
    sandboxConfig?: SandboxConfig;
    allowlist?: string[];
    allowedSecrets?: string[];
    authResolver?: AuthResolver;
  }) => ExecRuntime;
}

export function shouldSanitizeTools(config: MoziConfig, modelSpec: ModelSpec): boolean {
  if (config.runtime?.sanitizeToolSchema === false) {
    return false;
  }
  return modelSpec.id.toLowerCase().includes("gemini");
}

function wrapToolWithRuntimeHooks(
  tool: AgentTool,
  params: {
    sessionKey: string;
    agentId: string;
  },
): AgentTool {
  return {
    ...tool,
    execute: async (toolCallId: string, rawArgs: unknown) => {
      const hookRunner = getRuntimeHookRunner();
      const hasBefore = hookRunner.hasHooks("before_tool_call");
      const hasAfter = hookRunner.hasHooks("after_tool_call");

      if (!hasBefore && !hasAfter) {
        return tool.execute(toolCallId, rawArgs);
      }

      let nextArgs = rawArgs;
      const hookArgs =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};

      if (hasBefore) {
        const before = await hookRunner.runBeforeToolCall(
          {
            toolName: tool.name,
            args: hookArgs,
          },
          {
            sessionKey: params.sessionKey,
            agentId: params.agentId,
          },
        );
        if (before?.block) {
          const reason = before.blockReason?.trim();
          return {
            content: [
              {
                type: "text",
                text: reason
                  ? `Tool call blocked by runtime hook: ${reason}`
                  : "Tool call blocked by runtime hook.",
              },
            ],
            details: {
              blocked: true,
              reason: reason || "blocked-by-runtime-hook",
              toolName: tool.name,
            },
          };
        }
        if (before?.args) {
          nextArgs = before.args;
        }
      }

      const startedAt = Date.now();
      try {
        const result = await tool.execute(toolCallId, nextArgs);
        if (hasAfter) {
          await hookRunner.runAfterToolCall(
            {
              toolName: tool.name,
              args:
                nextArgs && typeof nextArgs === "object" && !Array.isArray(nextArgs)
                  ? (nextArgs as Record<string, unknown>)
                  : {},
              result,
              durationMs: Math.max(0, Date.now() - startedAt),
            },
            {
              sessionKey: params.sessionKey,
              agentId: params.agentId,
            },
          );
        }
        return result;
      } catch (error) {
        if (hasAfter) {
          await hookRunner.runAfterToolCall(
            {
              toolName: tool.name,
              args:
                nextArgs && typeof nextArgs === "object" && !Array.isArray(nextArgs)
                  ? (nextArgs as Record<string, unknown>)
                  : {},
              error: error instanceof Error ? error.message : String(error),
              durationMs: Math.max(0, Date.now() - startedAt),
            },
            {
              sessionKey: params.sessionKey,
              agentId: params.agentId,
            },
          );
        }
        throw error;
      }
    },
  };
}

export async function buildTools(
  params: BuildToolsParams,
  deps: BuildToolsDeps,
): Promise<AgentTool[]> {
  const allowList = resolveToolAllowList(deps.config, params.entry);
  const allowSet = new Set(allowList);
  const tools: AgentTool[] = [];

  if (deps.subagents) {
    tools.push(
      createSubagentTool({
        subagents: deps.subagents,
        parentSessionKey: params.sessionKey,
        parentAgentId: params.agentId,
      }),
    );
  }

  if (deps.skillLoader && allowSet.has("skills_note")) {
    tools.push(
      createSkillsNoteTool({
        homeDir: params.homeDir,
        skillLoader: deps.skillLoader,
      }),
    );
  }

  if (allowSet.has("exec")) {
    const allowlist = resolveExecAllowlist(deps.config, params.entry);
    const allowedSecrets = resolveExecAllowedSecrets(deps.config, params.entry);
    const authResolver = deps.config.runtime?.auth?.enabled
      ? createRuntimeSecretBroker({
          masterKeyEnv: deps.config.runtime?.auth?.masterKeyEnv ?? "MOZI_MASTER_KEY",
        })
      : undefined;

    const runtime = deps.getExecRuntime({
      workspaceDir: params.workspaceDir,
      sandboxConfig: params.sandboxConfig,
      allowlist,
      allowedSecrets,
      authResolver,
    });
    tools.push(
      createExecTool({
        runtime,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
      }),
    );
  }

  if (allowSet.has("process")) {
    tools.push(...createProcessTools({ sessionKey: params.sessionKey, agentId: params.agentId }));
  }

  const codingTools = filterTools(createPiCodingTools(params.workspaceDir), allowList).tools;
  tools.push(...codingTools);

  if (allowSet.has("memory_search") || allowSet.has("memory_get")) {
    const manager = await getMemoryManager(deps.config, params.agentId);
    const lifecycle = await getMemoryLifecycleOrchestrator(deps.config, params.agentId);
    void lifecycle.handle({ type: "session_start", sessionKey: params.sessionKey }).catch((err) => {
      logger.warn({ err, sessionKey: params.sessionKey }, "Memory lifecycle session_start failed");
    });

    const lifecycleAwareManager: MemorySearchManager = {
      search: async (query: string, opts?: { maxResults?: number; minScore?: number }) => {
        void lifecycle
          .handle({ type: "search_requested", sessionKey: params.sessionKey })
          .catch((err) => {
            logger.warn(
              { err, sessionKey: params.sessionKey },
              "Memory lifecycle search_requested failed",
            );
          });
        return manager.search(query, opts);
      },
      readFile: (args: { relPath: string; from?: number; lines?: number }) =>
        manager.readFile(args),
      status: () => manager.status(),
      probeEmbeddingAvailability: () => manager.probeEmbeddingAvailability(),
      probeVectorAvailability: () => manager.probeVectorAvailability(),
    };
    if (manager.warmSession) {
      lifecycleAwareManager.warmSession = (sessionKey?: string) => manager.warmSession!(sessionKey);
    }
    if (manager.markDirty) {
      lifecycleAwareManager.markDirty = () => manager.markDirty!();
    }
    if (manager.sync) {
      lifecycleAwareManager.sync = (args) => manager.sync!(args);
    }
    if (manager.close) {
      lifecycleAwareManager.close = () => manager.close!();
    }

    const memoryTools = createMemoryTools({
      manager: lifecycleAwareManager,
      sessionKey: params.sessionKey,
    });
    const filtered = filterTools(memoryTools, allowList).tools;
    tools.push(...filtered);
  }

  if (deps.toolProvider) {
    const provided = await deps.toolProvider({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      homeDir: params.homeDir,
      sandboxConfig: params.sandboxConfig,
    });
    // Channel-capability tools (e.g. send_media) bypass the allowList — the channel's
    // own getCapabilities() is the gate, not the agent config tools array.
    const CHANNEL_TOOLS = new Set(["send_media"]);
    const channelTools = provided.filter((t) => CHANNEL_TOOLS.has(t.name));
    const regularTools = provided.filter((t) => !CHANNEL_TOOLS.has(t.name));
    tools.push(...filterTools(regularTools, allowList).tools, ...channelTools);
  }

  // Inject tools from enabled extensions
  const extensionTools = deps.extensionRegistry.collectTools();
  if (extensionTools.length > 0) {
    const filtered = filterTools(extensionTools, allowList).tools;
    tools.push(...filtered);
  }

  const toolsWithHooks = tools.map((tool) =>
    wrapToolWithRuntimeHooks(tool, {
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    }),
  );

  if (shouldSanitizeTools(deps.config, params.modelSpec)) {
    return sanitizeTools(toolsWithHooks);
  }
  return toolsWithHooks;
}

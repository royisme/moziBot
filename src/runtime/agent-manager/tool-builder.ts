import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { SkillLoader } from "../../agents/skills/loader";
import type { MoziConfig } from "../../config";
import type { ExtensionRegistry } from "../../extensions";
import type { MemorySearchManager } from "../../memory/types";
import type { SandboxExecutor } from "../sandbox/executor";
import type { SandboxConfig } from "../sandbox/types";
import type { SubagentRegistry } from "../subagent-registry";
import type { ModelSpec } from "../types";
import type { AgentEntry } from "./config-resolver";
import { getMemoryManager, getMemoryLifecycleOrchestrator } from "../../memory";
import { createRuntimeSecretBroker } from "../auth/broker";
import { createExecTool } from "../sandbox/tool";
import { sanitizeTools } from "../schema-sanitizer";
import { createSkillsNoteTool } from "../skills-note";
import { filterTools } from "../tool-selection";
import { createMemoryTools, createPiCodingTools, createSubagentTool } from "../tools";
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
  getSandboxExecutor: (params: {
    sandboxConfig?: SandboxConfig;
    allowlist?: string[];
  }) => SandboxExecutor;
}

export function shouldSanitizeTools(config: MoziConfig, modelSpec: ModelSpec): boolean {
  if (config.runtime?.sanitizeToolSchema === false) {
    return false;
  }
  return modelSpec.id.toLowerCase().includes("gemini");
}

export async function buildTools(
  params: BuildToolsParams,
  deps: BuildToolsDeps,
): Promise<AgentTool[]> {
  const allowList = resolveToolAllowList(deps.config, params.entry);
  const allowSet = new Set(allowList);
  const tools: AgentTool[] = [];

  if (deps.subagents && allowSet.has("subagent_run")) {
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
    const executor = deps.getSandboxExecutor({
      sandboxConfig: params.sandboxConfig,
      allowlist,
    });
    tools.push(
      createExecTool({
        executor,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
        allowedSecrets,
        authResolver: deps.config.runtime?.auth?.enabled
          ? createRuntimeSecretBroker({
              masterKeyEnv: deps.config.runtime?.auth?.masterKeyEnv ?? "MOZI_MASTER_KEY",
            })
          : undefined,
      }),
    );
  }

  const codingTools = filterTools(createPiCodingTools(params.workspaceDir), allowList).tools;
  tools.push(...codingTools);

  if (allowSet.has("memory_search") || allowSet.has("memory_get")) {
    const manager = await getMemoryManager(deps.config, params.agentId);
    const lifecycle = await getMemoryLifecycleOrchestrator(deps.config, params.agentId);
    await lifecycle.handle({ type: "session_start", sessionKey: params.sessionKey });

    const lifecycleAwareManager: MemorySearchManager = {
      search: async (query: string, opts?: { maxResults?: number; minScore?: number }) => {
        await lifecycle.handle({ type: "search_requested", sessionKey: params.sessionKey });
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
    const filtered = filterTools(provided, allowList).tools;
    tools.push(...filtered);
  }

  // Inject tools from enabled extensions
  const extensionTools = deps.extensionRegistry.collectTools();
  if (extensionTools.length > 0) {
    const filtered = filterTools(extensionTools, allowList).tools;
    tools.push(...filtered);
  }

  if (shouldSanitizeTools(deps.config, params.modelSpec)) {
    return sanitizeTools(tools);
  }
  return tools;
}

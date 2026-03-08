import fs from "node:fs/promises";
import path from "node:path";
import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { MoziConfig } from "../../../config";
import { logger } from "../../../logger";
import { resolveHomeDir } from "../../../memory/backend-config";
import type { AgentEntry } from "../../agent-manager/config-resolver";
import { resolveWorkspaceDir } from "../../agent-manager/config-resolver";
import { getAgentFastModelCandidates } from "../../agent-manager/model-routing-service";
import { resolveAgentModelRef } from "../../agent-manager/model-session-service";
import { ModelRegistry } from "../../model-registry";
import { ProviderRegistry } from "../../provider-registry";
import type { ModelSpec } from "../../types";
import { registerRuntimeHook } from "../index";
import type {
  BeforeResetEvent,
  BeforeResetContext,
  TurnCompletedContext,
  TurnCompletedEvent,
} from "../types";
import { MemoryInboxStore } from "../../../memory/governance/inbox-store";
import {
  MemoryExtractionService,
  containsSecret,
  renderMessageText,
} from "../../../memory/governance/extraction-service";
import { GovernanceMaintenanceRunner } from "../../../memory/governance/maintenance-runner";
import {
  resolveGovernanceConfig,
  type GovernanceConfig,
} from "../../../memory/governance/config";

const MIN_TURNS_BEFORE_FLUSH = 3;
const FLUSH_DEBOUNCE_MS = 120_000;
const SESSION_MEMORY_DEFAULT_MESSAGES = 15;
const SESSION_MEMORY_DEFAULT_TIMEOUT_MS = 15_000;
const SESSION_MEMORY_MAX_CONTENT_CHARS = 2000;
const MAX_LINE_CHARS = 240;

type SessionBuffer = {
  turnCount: number;
  lastFlushedAt: number;
};

let runtimeConfig: MoziConfig | null = null;
let governanceConfig: GovernanceConfig | null = null;
let installed = false;
const sessionBuffers = new Map<string, SessionBuffer>();
/** Cached per-agentId extraction service instances (avoid per-call allocation). */
const extractionServices = new Map<string, MemoryExtractionService>();
const maintenanceRunners = new Map<string, GovernanceMaintenanceRunner>();
const maintenanceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingMaintenanceDates = new Map<string, Set<string>>();

type SessionMemoryConfig = {
  enabled: boolean;
  messages: number;
  llmSlug: boolean;
  model?: string;
  timeoutMs: number;
};

function resolveSessionMemoryConfig(config: MoziConfig | null): SessionMemoryConfig | null {
  if (!config?.hooks?.sessionMemory) {
    return null;
  }
  const raw = config.hooks.sessionMemory;
  return {
    enabled: raw.enabled !== false,
    messages:
      typeof raw.messages === "number" && raw.messages > 0
        ? raw.messages
        : SESSION_MEMORY_DEFAULT_MESSAGES,
    llmSlug: raw.llmSlug !== false,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined,
    timeoutMs:
      typeof raw.timeoutMs === "number" && raw.timeoutMs > 0
        ? raw.timeoutMs
        : SESSION_MEMORY_DEFAULT_TIMEOUT_MS,
  };
}

function buildSessionSummary(messages: AgentMessage[] | undefined, maxMessages: number): string {
  if (!messages || messages.length === 0) {
    return "";
  }
  const filtered = messages
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .slice(-maxMessages);

  const lines = filtered
    .map((msg) => {
      const role = msg.role === "user" ? "user" : "assistant";
      const text = renderMessageText(msg.content).trim();
      if (!text || text.startsWith("/")) {
        return null;
      }
      if (containsSecret(text)) {
        return null;
      }
      const clipped = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}...` : text;
      return `${role}: ${clipped}`;
    })
    .filter((line): line is string => Boolean(line));

  return lines.join("\n").slice(0, SESSION_MEMORY_MAX_CONTENT_CHARS);
}

function buildTimestampSlug(now: Date): string {
  const timeSlug = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "");
  return timeSlug.slice(0, 4);
}

function normalizeSlug(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return cleaned || null;
}

function buildPiModel(spec: ModelSpec): Model<Api> {
  return {
    id: spec.id,
    name: spec.id,
    api: spec.api,
    provider: spec.provider,
    baseUrl: spec.baseUrl,
    reasoning: spec.reasoning ?? false,
    input: spec.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow ?? 128000,
    maxTokens: spec.maxTokens ?? 8192,
    headers: spec.headers,
  } as Model<Api>;
}

async function generateSlugViaLlm(params: {
  config: MoziConfig;
  agentId: string;
  sessionKey: string;
  sessionContent: string;
  timeoutMs: number;
  modelOverride?: string;
}): Promise<string | null> {
  const modelRegistry = new ModelRegistry(params.config);
  const providerRegistry = new ProviderRegistry(params.config);
  const candidates = [
    params.modelOverride,
    ...getAgentFastModelCandidates({ config: params.config, agentId: params.agentId }),
    resolveAgentModelRef({ config: params.config, agentId: params.agentId }),
  ].filter((ref): ref is string => Boolean(ref));

  let modelRef: string | null = null;
  for (const candidate of candidates) {
    const resolved = modelRegistry.resolve(candidate);
    if (resolved) {
      modelRef = resolved.ref;
      break;
    }
  }

  if (!modelRef) {
    return null;
  }

  const spec = modelRegistry.get(modelRef);
  if (!spec) {
    return null;
  }

  const agent = new Agent({
    initialState: {
      systemPrompt:
        "You are a utility that generates short filename slugs from conversation summaries.",
      model: buildPiModel(spec),
      tools: [],
      messages: [],
    },
    sessionId: `session-memory-slug:${Date.now()}`,
    getApiKey: (provider) => providerRegistry.resolveApiKey(provider),
  });

  const prompt = `Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).\n\nConversation summary:\n${params.sessionContent}\n\nReply with ONLY the slug, nothing else. Examples: "vendor-pitch", "api-design", "bug-fix".`;

  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), params.timeoutMs);
  });

  const run = (async () => {
    await agent.prompt(prompt);
    const last = [...agent.state.messages].toReversed().find((msg) => msg.role === "assistant");
    const text = last ? renderMessageText(last.content).trim() : "";
    return text ? normalizeSlug(text) : null;
  })();

  return await Promise.race([run, timeoutPromise]);
}

function getBufferKey(ctx: { sessionKey?: string; agentId?: string }): string | null {
  if (!ctx.sessionKey || !ctx.agentId) {
    return null;
  }
  return `${ctx.agentId}:${ctx.sessionKey}`;
}

function getOrCreateBuffer(key: string): SessionBuffer {
  const existing = sessionBuffers.get(key);
  if (existing) {
    return existing;
  }
  const created: SessionBuffer = {
    turnCount: 0,
    lastFlushedAt: 0,
  };
  sessionBuffers.set(key, created);
  return created;
}

function makeExtractionService(agentId: string): MemoryExtractionService | null {
  if (!runtimeConfig) return null;
  const cached = extractionServices.get(agentId);
  if (cached) return cached;
  const homeDir = resolveHomeDir(runtimeConfig, agentId);
  const inboxBaseDir = path.join(homeDir, "memory");
  const inbox = new MemoryInboxStore(inboxBaseDir);
  const service = new MemoryExtractionService(inbox);
  extractionServices.set(agentId, service);
  return service;
}

function makeMaintenanceRunner(agentId: string): GovernanceMaintenanceRunner | null {
  if (!runtimeConfig) return null;
  const cached = maintenanceRunners.get(agentId);
  if (cached) return cached;
  const homeDir = resolveHomeDir(runtimeConfig, agentId);
  const runner = new GovernanceMaintenanceRunner(homeDir);
  maintenanceRunners.set(agentId, runner);
  return runner;
}

async function scheduleMaintenance(agentId: string, candidates: Array<{ ts: string }>): Promise<void> {
  if (!runtimeConfig || !governanceConfig || candidates.length === 0) {
    return;
  }
  if (!governanceConfig.enabled || !governanceConfig.maintenanceAutoRun) {
    return;
  }

  const runner = makeMaintenanceRunner(agentId);
  if (!runner) {
    return;
  }

  const dates = candidates.map((candidate) => new Date(candidate.ts).toISOString().slice(0, 10));

  if (governanceConfig.dailyCompilerDebounceMs <= 0) {
    for (const date of new Set(dates)) {
      await runner.runForDate(date);
    }
    return;
  }

  const pendingDates = pendingMaintenanceDates.get(agentId) ?? new Set<string>();
  for (const date of dates) {
    pendingDates.add(date);
  }
  pendingMaintenanceDates.set(agentId, pendingDates);

  const existing = maintenanceTimers.get(agentId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    maintenanceTimers.delete(agentId);
    const scheduledDates = [...(pendingMaintenanceDates.get(agentId) ?? new Set<string>())];
    pendingMaintenanceDates.delete(agentId);
    void (async () => {
      for (const date of scheduledDates) {
        await runner.runForDate(date);
      }
    })().catch((error) =>
      logger.warn(
        { error, agentId, dates: scheduledDates },
        "Memory maintainer: governance maintenance failed",
      ),
    );
  }, governanceConfig.dailyCompilerDebounceMs);

  maintenanceTimers.set(agentId, timer);
}

/**
 * Session snapshot: writes a human-readable session summary to the workspace
 * memory directory. This is intentionally kept separate from durable memory
 * governance – it is context-continuity output only, not a durable memory write.
 */
async function writeSessionMemorySnapshot(params: {
  sessionKey: string;
  agentId: string;
  reason: string;
  messages?: AgentMessage[];
}): Promise<void> {
  if (!runtimeConfig) {
    return;
  }
  const config = resolveSessionMemoryConfig(runtimeConfig);
  if (!config || !config.enabled) {
    return;
  }

  const summary = buildSessionSummary(params.messages, config.messages);
  if (!summary) {
    return;
  }

  const now = new Date();
  let slug = buildTimestampSlug(now);

  const isTestEnv =
    process.env.VITEST === "true" || process.env.VITEST === "1" || process.env.NODE_ENV === "test";

  if (config.llmSlug && !isTestEnv) {
    try {
      const candidate = await generateSlugViaLlm({
        config: runtimeConfig,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionContent: summary,
        timeoutMs: config.timeoutMs,
        modelOverride: config.model,
      });
      if (candidate) {
        slug = candidate;
      }
    } catch (error) {
      logger.warn(
        { error, sessionKey: params.sessionKey, agentId: params.agentId },
        "Session memory slug generation failed",
      );
    }
  }

  const dateStr = now.toISOString().split("T")[0];
  const timeStr = now.toISOString().split("T")[1].split(".")[0];
  const agentEntry = (runtimeConfig.agents as Record<string, AgentEntry> | undefined)?.[
    params.agentId
  ];
  const workspaceDir = resolveWorkspaceDir(runtimeConfig, params.agentId, agentEntry);
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });

  const filename = `${dateStr}-${slug}.md`;
  const memoryFilePath = path.join(memoryDir, filename);

  const entryParts = [
    `# Session: ${dateStr} ${timeStr} UTC`,
    "",
    `- **Session Key**: ${params.sessionKey}`,
    `- **Agent ID**: ${params.agentId}`,
    `- **Reason**: ${params.reason}`,
    "",
    "## Conversation Summary",
    "",
    summary,
    "",
  ];

  await fs.writeFile(memoryFilePath, entryParts.join("\n"), "utf-8");
  logger.info(
    {
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      path: memoryFilePath,
    },
    "Session memory snapshot written",
  );
}

async function handleTurnCompleted(
  event: TurnCompletedEvent,
  ctx: TurnCompletedContext,
): Promise<void> {
  if (event.status !== "success") {
    return;
  }
  const key = getBufferKey(ctx);
  if (!key || !ctx.sessionKey || !ctx.agentId) {
    return;
  }

  const buffer = getOrCreateBuffer(key);
  buffer.turnCount += 1;

  const now = Date.now();
  if (buffer.turnCount < MIN_TURNS_BEFORE_FLUSH) {
    return;
  }
  if (now - buffer.lastFlushedAt < FLUSH_DEBOUNCE_MS) {
    return;
  }

  const service = makeExtractionService(ctx.agentId);
  if (!service) return;

  try {
    const result = await service.extractFromTurnAndSubmit({
      userText: event.userText,
      replyText: event.replyText,
      agentId: ctx.agentId,
      sessionId: ctx.sessionKey,
    });
    if (result.written > 0) {
      logger.info(
        {
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          written: result.written,
          reason: "turn_completed",
        },
        "Memory maintainer: candidates submitted to inbox",
      );
      await scheduleMaintenance(ctx.agentId, result.candidates);
      sessionBuffers.set(key, {
        turnCount: 0,
        lastFlushedAt: Date.now(),
      });
    }
  } catch (error) {
    logger.warn(
      { error, sessionKey: ctx.sessionKey, agentId: ctx.agentId },
      "Memory maintainer: turn_completed extraction failed",
    );
  }

}

async function handleBeforeReset(event: BeforeResetEvent, ctx: BeforeResetContext): Promise<void> {
  const key = getBufferKey(ctx);
  if (!key || !ctx.sessionKey || !ctx.agentId) {
    return;
  }

  const service = makeExtractionService(ctx.agentId);
  if (service) {
    try {
      const result = await service.extractFromMessagesAndSubmit({
        messages: event.messages,
        source: "before_reset",
        agentId: ctx.agentId,
        sessionId: ctx.sessionKey,
      });
      if (result.written > 0) {
        logger.info(
          {
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
            written: result.written,
            reason: event.reason || "reset",
          },
          "Memory maintainer: before_reset candidates submitted to inbox",
        );
        await scheduleMaintenance(ctx.agentId, result.candidates);
      }
    } catch (error) {
      logger.warn(
        { error, sessionKey: ctx.sessionKey, agentId: ctx.agentId },
        "Memory maintainer: before_reset extraction failed",
      );
    }
  }

  // Session snapshot is context-continuity output only, kept separate from
  // durable memory governance per spec §Separation of Concerns.
  void writeSessionMemorySnapshot({
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    reason: event.reason || "reset",
    messages: event.messages,
  }).catch((error) =>
    logger.warn(
      { error, sessionKey: ctx.sessionKey, agentId: ctx.agentId },
      "Session memory snapshot failed",
    ),
  );
}

export function configureMemoryMaintainerHooks(config: MoziConfig): void {
  runtimeConfig = config;
  governanceConfig = resolveGovernanceConfig(config.memory?.governance);
  extractionServices.clear();
  maintenanceRunners.clear();
  pendingMaintenanceDates.clear();
  for (const timer of maintenanceTimers.values()) {
    clearTimeout(timer);
  }
  maintenanceTimers.clear();
  if (installed) {
    return;
  }
  registerRuntimeHook("turn_completed", handleTurnCompleted, {
    id: "memory-maintainer:turn_completed",
    priority: -50,
  });
  registerRuntimeHook("before_reset", handleBeforeReset, {
    id: "memory-maintainer:before_reset",
    priority: -50,
  });
  installed = true;
}

export function resetMemoryMaintainerHooksForTests(): void {
  runtimeConfig = null;
  governanceConfig = null;
  installed = false;
  sessionBuffers.clear();
  extractionServices.clear();
  maintenanceRunners.clear();
  pendingMaintenanceDates.clear();
  for (const timer of maintenanceTimers.values()) {
    clearTimeout(timer);
  }
  maintenanceTimers.clear();
}

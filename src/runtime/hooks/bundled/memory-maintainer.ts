import type { Api, Model } from "@mariozechner/pi-ai";
import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import path from "node:path";
import type { MoziConfig } from "../../../config";
import type { AgentEntry } from "../../agent-manager/config-resolver";
import type { ModelSpec } from "../../types";
import type {
  BeforeResetEvent,
  BeforeResetContext,
  TurnCompletedContext,
  TurnCompletedEvent,
} from "../types";
import { logger } from "../../../logger";
import { resolveHomeDir } from "../../../memory/backend-config";
import { resolveWorkspaceDir } from "../../agent-manager/config-resolver";
import { getAgentFastModelCandidates } from "../../agent-manager/model-routing-service";
import { resolveAgentModelRef } from "../../agent-manager/model-session-service";
import { ModelRegistry } from "../../model-registry";
import { ProviderRegistry } from "../../provider-registry";
import { registerRuntimeHook } from "../index";

const MIN_TURNS_BEFORE_FLUSH = 3;
const FLUSH_DEBOUNCE_MS = 120_000;
const MAX_LINES_PER_FLUSH = 8;
const MAX_LINE_CHARS = 240;
const SESSION_MEMORY_DEFAULT_MESSAGES = 15;
const SESSION_MEMORY_DEFAULT_TIMEOUT_MS = 15_000;
const SESSION_MEMORY_MAX_CONTENT_CHARS = 2000;

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /bot\d{8,}:[A-Za-z0-9_-]{20,}/,
  /(Bearer\s+)[A-Za-z0-9._-]{16,}/i,
  /tvly-[A-Za-z0-9_-]{16,}/i,
];

type SessionBuffer = {
  lines: string[];
  turnCount: number;
  lastFlushedAt: number;
};

let runtimeConfig: MoziConfig | null = null;
let installed = false;
const sessionBuffers = new Map<string, SessionBuffer>();

function hasSecretLikeContent(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toLine(prefix: "User" | "Assistant", value: string): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  if (hasSecretLikeContent(normalized)) {
    return null;
  }
  const clipped =
    normalized.length > MAX_LINE_CHARS ? `${normalized.slice(0, MAX_LINE_CHARS)}...` : normalized;
  return `${prefix}: ${clipped}`;
}

function renderMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

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
      if (hasSecretLikeContent(text)) {
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

function extractLinesFromMessages(messages: AgentMessage[] | undefined): string[] {
  if (!messages || messages.length === 0) {
    return [];
  }
  const raw = messages
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .slice(-10)
    .map((msg) =>
      msg.role === "user"
        ? toLine("User", renderMessageText(msg.content))
        : toLine("Assistant", renderMessageText(msg.content)),
    )
    .filter((line): line is string => Boolean(line));
  return raw;
}

function extractLinesFromTurn(event: TurnCompletedEvent): string[] {
  const lines: string[] = [];
  if (event.userText) {
    const userLine = toLine("User", event.userText);
    if (userLine) {
      lines.push(userLine);
    }
  }
  if (event.replyText) {
    const assistantLine = toLine("Assistant", event.replyText);
    if (assistantLine) {
      lines.push(assistantLine);
    }
  }
  return lines;
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
    lines: [],
    turnCount: 0,
    lastFlushedAt: 0,
  };
  sessionBuffers.set(key, created);
  return created;
}

async function writeMemoryArtifacts(params: {
  homeDir: string;
  reason: string;
  lines: string[];
}): Promise<void> {
  const uniqueLines = Array.from(new Set(params.lines)).slice(0, MAX_LINES_PER_FLUSH);
  if (uniqueLines.length === 0) {
    return;
  }

  const now = new Date();
  const iso = now.toISOString();
  const date = iso.split("T")[0];
  const memoryRootFile = path.join(params.homeDir, "MEMORY.md");
  const memoryDir = path.join(params.homeDir, "memory");
  const archiveFile = path.join(memoryDir, `${date}.md`);

  await fs.mkdir(memoryDir, { recursive: true });

  let existing = "";
  try {
    existing = await fs.readFile(memoryRootFile, "utf-8");
  } catch {
    existing = "";
  }

  const freshLines = uniqueLines.filter((line) => !existing.includes(line));
  if (freshLines.length > 0) {
    if (!existing.trim()) {
      await fs.writeFile(memoryRootFile, "# MEMORY\n", "utf-8");
    }
    const section = [
      "",
      "",
      `## Auto Memory ${iso}`,
      `Reason: ${params.reason}`,
      ...freshLines.map((line) => `- ${line}`),
      "",
    ].join("\n");
    await fs.appendFile(memoryRootFile, section, "utf-8");
  }

  const archiveSection = [
    "",
    "",
    `### Auto Memory Flush ${iso} (${params.reason})`,
    ...uniqueLines.map((line) => `- ${line}`),
    "",
  ].join("\n");
  await fs.appendFile(archiveFile, archiveSection, "utf-8");
}

async function flushSessionBuffer(params: {
  key: string;
  sessionKey: string;
  agentId: string;
  reason: string;
  extraLines?: string[];
}): Promise<void> {
  if (!runtimeConfig) {
    return;
  }
  const buffer = sessionBuffers.get(params.key);
  const candidate = [...(buffer?.lines ?? []), ...(params.extraLines ?? [])].filter(
    (line) => line && line.trim().length > 0,
  );

  if (candidate.length === 0) {
    return;
  }

  const homeDir = resolveHomeDir(runtimeConfig, params.agentId);
  try {
    await writeMemoryArtifacts({
      homeDir,
      reason: params.reason,
      lines: candidate,
    });
    logger.info(
      {
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        reason: params.reason,
        lineCount: candidate.length,
      },
      "Memory maintainer wrote memory artifacts",
    );
  } catch (error) {
    logger.warn(
      {
        error,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
      },
      "Memory maintainer flush failed",
    );
  }

  sessionBuffers.set(params.key, {
    lines: [],
    turnCount: 0,
    lastFlushedAt: Date.now(),
  });
}

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
  const lines = extractLinesFromTurn(event);
  if (lines.length === 0) {
    return;
  }

  const buffer = getOrCreateBuffer(key);
  buffer.lines.push(...lines);
  buffer.turnCount += 1;

  const now = Date.now();
  if (buffer.turnCount < MIN_TURNS_BEFORE_FLUSH) {
    return;
  }
  if (now - buffer.lastFlushedAt < FLUSH_DEBOUNCE_MS) {
    return;
  }

  await flushSessionBuffer({
    key,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    reason: "turn_completed",
  });
}

async function handleBeforeReset(event: BeforeResetEvent, ctx: BeforeResetContext): Promise<void> {
  const key = getBufferKey(ctx);
  if (!key || !ctx.sessionKey || !ctx.agentId) {
    return;
  }

  const messageLines = extractLinesFromMessages(event.messages);
  await flushSessionBuffer({
    key,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    reason: event.reason || "reset",
    extraLines: messageLines,
  });

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
  installed = false;
  sessionBuffers.clear();
}

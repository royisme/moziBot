import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import path from "node:path";
import type { MoziConfig } from "../../../config";
import type {
  BeforeResetEvent,
  BeforeResetContext,
  TurnCompletedContext,
  TurnCompletedEvent,
} from "../types";
import { logger } from "../../../logger";
import { resolveHomeDir } from "../../../memory/backend-config";
import { registerRuntimeHook } from "../index";

const MIN_TURNS_BEFORE_FLUSH = 3;
const FLUSH_DEBOUNCE_MS = 120_000;
const MAX_LINES_PER_FLUSH = 8;
const MAX_LINE_CHARS = 240;

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

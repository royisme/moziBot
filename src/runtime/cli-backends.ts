import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  registerApiProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Context,
  type StreamOptions,
} from "@mariozechner/pi-ai";
import { execa } from "execa";
import type { MoziConfig } from "../config";
import { logger } from "../logger";
import type { ModelDefinition, ModelSpec } from "./types";

export type CliBackendOutput = "json" | "jsonl" | "text";
export type CliBackendInput = "arg" | "stdin";
export type CliBackendSessionMode = "always" | "existing" | "none";
export type CliBackendSystemPromptWhen = "first" | "always" | "never";
export type CliBackendImageMode = "repeat" | "append";

export type CliBackendConfig = {
  command: string;
  args?: string[];
  resumeArgs?: string[];
  output?: CliBackendOutput;
  resumeOutput?: CliBackendOutput;
  input?: CliBackendInput;
  promptArg?: string;
  modelArg?: string;
  modelAliases?: Record<string, string>;
  sessionArg?: string;
  sessionArgs?: string[];
  sessionMode?: CliBackendSessionMode;
  sessionIdFields?: string[];
  systemPromptArg?: string;
  systemPromptWhen?: CliBackendSystemPromptWhen;
  imageArg?: string;
  imageMode?: CliBackendImageMode;
  serialize?: boolean;
  maxPromptArgChars?: number;
  models?: string[];
};

type CliBackendMap = Record<string, CliBackendConfig>;

const DEFAULT_CLI_BACKENDS: CliBackendMap = {
  "google-gemini-cli": {
    command: "gemini",
    args: ["-o", "json"],
    resumeArgs: ["-o", "json", "--resume", "{sessionId}"],
    output: "json",
    resumeOutput: "json",
    input: "arg",
    promptArg: "-p",
    modelArg: "-m",
    sessionMode: "existing",
    sessionIdFields: ["session_id", "conversation_id", "thread_id"],
    serialize: true,
    maxPromptArgChars: 12000,
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  "claude-cli": {
    command: "claude",
    args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"],
    resumeArgs: [
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--resume",
      "{sessionId}",
    ],
    output: "json",
    resumeOutput: "json",
    input: "arg",
    modelArg: "--model",
    systemPromptArg: "--append-system-prompt",
    sessionArg: "--session-id",
    sessionMode: "always",
    systemPromptWhen: "first",
    serialize: true,
    models: ["opus-4.6", "opus-4.5", "sonnet-4.5", "sonnet-4.1"],
  },
  "codex-cli": {
    command: "codex",
    args: ["exec", "--json", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check"],
    resumeArgs: [
      "exec",
      "resume",
      "{sessionId}",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
    ],
    output: "jsonl",
    resumeOutput: "text",
    input: "arg",
    modelArg: "--model",
    imageArg: "--image",
    imageMode: "repeat",
    sessionMode: "existing",
    sessionIdFields: ["thread_id", "session_id", "conversation_id"],
    serialize: true,
    models: ["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini"],
  },
};

const DEFAULT_SESSION_ID_FIELDS = ["session_id", "conversation_id", "thread_id"];
const DEFAULT_OUTPUT: CliBackendOutput = "json";
const DEFAULT_INPUT: CliBackendInput = "arg";
const DEFAULT_SESSION_MODE: CliBackendSessionMode = "none";
const DEFAULT_SYSTEM_PROMPT_WHEN: CliBackendSystemPromptWhen = "never";

let activeBackends: CliBackendMap = DEFAULT_CLI_BACKENDS;
let providerRegistered = false;
const backendQueues = new Map<string, Promise<unknown>>();
const backendSessions = new Map<string, Map<string, string>>();

export function configureCliBackends(config: MoziConfig): void {
  const overrides = (
    config.agents?.defaults as { cliBackends?: Record<string, CliBackendConfig> } | undefined
  )?.cliBackends;
  if (!overrides) {
    activeBackends = DEFAULT_CLI_BACKENDS;
    return;
  }

  const merged: CliBackendMap = { ...DEFAULT_CLI_BACKENDS };
  for (const [id, override] of Object.entries(overrides)) {
    const base = merged[id] || {};
    merged[id] = {
      ...base,
      ...override,
      models: override.models ?? base.models,
      modelAliases: override.modelAliases ?? base.modelAliases,
    };
  }
  activeBackends = merged;
}

export function listCliBackendModels(config: MoziConfig): ModelSpec[] {
  const models: ModelSpec[] = [];
  const backends = resolveCliBackends(config);
  for (const [providerId, backend] of Object.entries(backends)) {
    const modelIds = backend.models ?? [];
    for (const modelId of modelIds) {
      models.push({
        id: modelId,
        provider: providerId,
        api: "cli-backend",
        baseUrl: "cli://local",
        apiKey: "LOCAL_CLI_KEY",
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 8192,
      });
    }
  }
  return models;
}

export function listCliBackendModelDefinitions(config: MoziConfig): Array<{
  providerId: string;
  models: ModelDefinition[];
}> {
  const result: Array<{ providerId: string; models: ModelDefinition[] }> = [];
  const backends = resolveCliBackends(config);
  for (const [providerId, backend] of Object.entries(backends)) {
    const modelIds = backend.models ?? [];
    if (modelIds.length === 0) {
      continue;
    }
    result.push({
      providerId,
      models: modelIds.map((id) => ({ id, name: id, input: ["text"] })),
    });
  }
  return result;
}

export function ensureCliBackendProviderRegistered(): void {
  if (providerRegistered) {
    return;
  }
  registerApiProvider({
    api: "cli-backend",
    stream: streamCliBackend,
    streamSimple: streamCliBackend,
  });
  providerRegistered = true;
}

function resolveCliBackends(config: MoziConfig): CliBackendMap {
  const overrides = (
    config.agents?.defaults as { cliBackends?: Record<string, CliBackendConfig> } | undefined
  )?.cliBackends;
  if (!overrides) {
    return DEFAULT_CLI_BACKENDS;
  }
  const merged: CliBackendMap = { ...DEFAULT_CLI_BACKENDS };
  for (const [id, override] of Object.entries(overrides)) {
    const base = merged[id] || {};
    merged[id] = {
      ...base,
      ...override,
      models: override.models ?? base.models,
      modelAliases: override.modelAliases ?? base.modelAliases,
    };
  }
  return merged;
}

function getBackend(providerId: string): CliBackendConfig | undefined {
  return activeBackends[providerId];
}

function resolveSessionKey(options?: StreamOptions): string | undefined {
  const key = options?.sessionId;
  return typeof key === "string" && key.trim() ? key : undefined;
}

function resolveBackendSessionId(backendId: string, sessionKey: string): string | undefined {
  return backendSessions.get(backendId)?.get(sessionKey);
}

function storeBackendSessionId(backendId: string, sessionKey: string, sessionId: string): void {
  let map = backendSessions.get(backendId);
  if (!map) {
    map = new Map();
    backendSessions.set(backendId, map);
  }
  map.set(sessionKey, sessionId);
}

function enqueueBackend<T>(
  backendId: string,
  task: () => Promise<T>,
  serialize: boolean,
): Promise<T> {
  if (!serialize) {
    return task();
  }
  const prev = backendQueues.get(backendId) ?? Promise.resolve();
  const next = prev.then(task, task);
  backendQueues.set(
    backendId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function renderContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const block = part as { type?: string; text?: string; content?: string; thinking?: string };
        if (typeof block.text === "string") {
          return block.text;
        }
        if (block.type === "text" && typeof block.content === "string") {
          return block.content;
        }
        if (block.type === "thinking" && typeof block.thinking === "string") {
          return block.thinking;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function renderContextPrompt(context: Context, includeSystemPrompt: boolean): string {
  const lines: string[] = [];
  if (includeSystemPrompt && context.systemPrompt) {
    lines.push(`System: ${context.systemPrompt.trim()}`);
  }
  for (const message of context.messages) {
    const role = message.role;
    const text = renderContentText((message as { content?: unknown }).content);
    if (!text.trim()) {
      continue;
    }
    if (role === "user") {
      lines.push(`User: ${text}`);
    } else if (role === "assistant") {
      lines.push(`Assistant: ${text}`);
    } else if (role === "toolResult") {
      lines.push(`Tool: ${text}`);
    }
  }
  return lines.join("\n\n").trim();
}

function resolveModelAlias(backend: CliBackendConfig, modelId: string): string {
  const aliases = backend.modelAliases || {};
  return aliases[modelId] || modelId;
}

function buildAssistantMessage(
  model: { api: string; provider: string; id: string },
  text: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function detectWorkspaceFromSystemPrompt(systemPrompt?: string): string | undefined {
  if (!systemPrompt) {
    return undefined;
  }
  const match = systemPrompt.match(/Sandbox workspace:\s*(.+)/i);
  if (!match) {
    return undefined;
  }
  const raw = match[1]?.trim();
  return raw ? raw : undefined;
}

function resolveImageExtension(mimeType?: string): string {
  if (!mimeType) {
    return ".png";
  }
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    return ".jpg";
  }
  if (mimeType.includes("webp")) {
    return ".webp";
  }
  if (mimeType.includes("gif")) {
    return ".gif";
  }
  if (mimeType.includes("png")) {
    return ".png";
  }
  return ".bin";
}

function collectImages(context: Context): Array<{ data: string; mimeType?: string }> {
  const images: Array<{ data: string; mimeType?: string }> = [];
  for (const message of context.messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      const block = part as { type?: string; data?: string; mimeType?: string };
      if (block.type === "image" && typeof block.data === "string") {
        images.push({ data: block.data, mimeType: block.mimeType });
      }
    }
  }
  return images;
}

function parseJsonOutput(
  payload: unknown,
  sessionIdFields: string[],
): { text: string; sessionId?: string } {
  if (!payload || typeof payload !== "object") {
    return { text: "" };
  }

  const obj = payload as Record<string, unknown>;
  const target = (obj.message && typeof obj.message === "object" ? obj.message : obj) as Record<
    string,
    unknown
  >;

  let sessionId: string | undefined;
  for (const key of sessionIdFields) {
    const value = target[key] ?? obj[key];
    if (typeof value === "string" && value.trim()) {
      sessionId = value.trim();
      break;
    }
  }

  const content =
    target.content ??
    target.output ??
    target.text ??
    target.result ??
    obj.content ??
    obj.output ??
    obj.text;

  const text = renderContentText(content);
  return { text, sessionId };
}

function parseJsonlOutput(
  text: string,
  sessionIdFields: string[],
): { text: string; sessionId?: string } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let sessionId: string | undefined;
  let accumulated = "";
  let fallbackText = "";

  for (const line of lines) {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const obj = payload as Record<string, unknown>;
    for (const key of sessionIdFields) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) {
        sessionId = value.trim();
        break;
      }
    }
    const type = typeof obj.type === "string" ? obj.type : "";
    if (typeof obj.delta === "string") {
      accumulated += obj.delta;
      continue;
    }
    if (type.includes("delta") && typeof obj.text === "string") {
      accumulated += obj.text;
      continue;
    }
    if (typeof obj.text === "string") {
      fallbackText = obj.text;
      continue;
    }
    if (obj.message && typeof obj.message === "object") {
      const parsed = parseJsonOutput(obj, sessionIdFields);
      if (parsed.text) {
        fallbackText = parsed.text;
      }
      if (parsed.sessionId && !sessionId) {
        sessionId = parsed.sessionId;
      }
    }
    if (obj.response && typeof obj.response === "object") {
      const parsed = parseJsonOutput(obj.response, sessionIdFields);
      if (parsed.text) {
        fallbackText = parsed.text;
      }
      if (parsed.sessionId && !sessionId) {
        sessionId = parsed.sessionId;
      }
    }
  }

  const textResult = accumulated.trim() ? accumulated : fallbackText;
  return { text: textResult, sessionId };
}

async function executeCli(params: {
  backendId: string;
  backend: CliBackendConfig;
  modelId: string;
  context: Context;
  options?: StreamOptions;
}): Promise<{ text: string; sessionId?: string }> {
  const { backendId, backend, modelId, context, options } = params;
  const sessionKey = resolveSessionKey(options);
  const storedSessionId = sessionKey ? resolveBackendSessionId(backendId, sessionKey) : undefined;
  const sessionMode = backend.sessionMode ?? DEFAULT_SESSION_MODE;
  const outputFormat = backend.output ?? DEFAULT_OUTPUT;
  const resumeOutput = backend.resumeOutput ?? outputFormat;
  const sessionIdFields = backend.sessionIdFields ?? DEFAULT_SESSION_ID_FIELDS;
  const serialize = backend.serialize ?? true;

  let activeSessionId = storedSessionId;
  if (sessionMode === "always" && sessionKey && !activeSessionId) {
    activeSessionId = crypto.randomUUID();
    storeBackendSessionId(backendId, sessionKey, activeSessionId);
  }

  const shouldResume = Boolean(activeSessionId && backend.resumeArgs && sessionMode !== "none");
  const isFirst = !storedSessionId;
  const systemPrompt = context.systemPrompt?.trim() || "";
  const systemPromptWhen = backend.systemPromptWhen ?? DEFAULT_SYSTEM_PROMPT_WHEN;
  const includeSystemPrompt =
    systemPromptWhen === "always" || (systemPromptWhen === "first" && isFirst);

  const prompt = renderContextPrompt(context, includeSystemPrompt && !backend.systemPromptArg);
  const inputMode = backend.input ?? DEFAULT_INPUT;

  const args =
    (shouldResume ? backend.resumeArgs : backend.args)?.map((arg) =>
      activeSessionId ? arg.replace("{sessionId}", activeSessionId) : arg,
    ) ?? [];

  if (backend.modelArg) {
    const resolvedModel = resolveModelAlias(backend, modelId);
    args.push(backend.modelArg, resolvedModel);
  }

  if (!shouldResume && sessionMode !== "none" && activeSessionId) {
    if (backend.sessionArg) {
      args.push(backend.sessionArg, activeSessionId);
    } else if (backend.sessionArgs && backend.sessionArgs.length > 0) {
      args.push(
        ...backend.sessionArgs.map((arg) =>
          activeSessionId ? arg.replace("{sessionId}", activeSessionId) : arg,
        ),
      );
    }
  }

  if (backend.systemPromptArg && includeSystemPrompt && systemPrompt) {
    args.push(backend.systemPromptArg, systemPrompt);
  }

  const tempFiles: string[] = [];
  const images = backend.imageArg ? collectImages(context) : [];
  if (backend.imageArg && images.length > 0) {
    for (const image of images) {
      const ext = resolveImageExtension(image.mimeType);
      const tempPath = path.join(os.tmpdir(), `mozi-cli-image-${crypto.randomUUID()}${ext}`);
      fs.writeFileSync(tempPath, Buffer.from(image.data, "base64"));
      tempFiles.push(tempPath);
      if (backend.imageMode === "repeat" || !backend.imageMode) {
        args.push(backend.imageArg, tempPath);
      }
    }
  }

  let finalPrompt = prompt;
  if (backend.imageArg && images.length > 0 && backend.imageMode === "append") {
    const pathsText = tempFiles.join("\n");
    finalPrompt = `${prompt}\n\nImages:\n${pathsText}`.trim();
  }

  const maxPromptArgChars = backend.maxPromptArgChars ?? 0;
  const useStdin =
    inputMode === "stdin" ||
    (inputMode === "arg" && maxPromptArgChars > 0 && finalPrompt.length > maxPromptArgChars);

  if (!useStdin) {
    if (backend.promptArg) {
      args.push(backend.promptArg, finalPrompt);
    } else {
      args.push(finalPrompt);
    }
  }

  const cwd = detectWorkspaceFromSystemPrompt(context.systemPrompt) || process.cwd();

  try {
    const result = await enqueueBackend(
      backendId,
      async () => {
        const execResult = await execa(backend.command, args, {
          input: useStdin ? finalPrompt : undefined,
          cwd,
          reject: false,
          env: process.env,
        });
        const stdout = execResult.stdout || "";
        const stderr = execResult.stderr || "";

        if (execResult.exitCode !== 0) {
          const err =
            stderr.trim() || stdout.trim() || `CLI exited with code ${execResult.exitCode}`;
          throw new Error(err);
        }

        const format = shouldResume ? resumeOutput : outputFormat;
        if (format === "text") {
          return { text: stdout.trim(), sessionId: storedSessionId };
        }
        if (format === "jsonl") {
          return parseJsonlOutput(stdout, sessionIdFields);
        }
        const payload = JSON.parse(stdout);
        return parseJsonOutput(payload, sessionIdFields);
      },
      serialize,
    );

    if (sessionKey && result.sessionId) {
      storeBackendSessionId(backendId, sessionKey, result.sessionId);
    }

    return { text: result.text ?? "", sessionId: result.sessionId };
  } finally {
    for (const tempPath of tempFiles) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
    }
  }
}

function streamCliBackend(
  model: Model<"cli-backend">,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const backend = getBackend(model.provider);
    if (!backend) {
      const errorMessage = `CLI backend not configured for provider: ${model.provider}`;
      const errorMessageObj = buildAssistantMessage(model, errorMessage);
      errorMessageObj.stopReason = "error";
      errorMessageObj.errorMessage = errorMessage;
      stream.push({ type: "error", reason: "error", error: errorMessageObj });
      stream.end();
      return;
    }

    try {
      const { text } = await executeCli({
        backendId: model.provider,
        backend,
        modelId: model.id,
        context,
        options,
      });
      const reply = text?.trim() ? text.trim() : "";
      const output = buildAssistantMessage(model, reply);
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error, provider: model.provider }, "CLI backend failed");
      const output = buildAssistantMessage(model, "");
      output.stopReason = "error";
      output.errorMessage = message;
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    }
  })();
  return stream;
}

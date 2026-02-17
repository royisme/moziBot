import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ExtensionManifest } from "../types";
import { registerBuiltinExtension } from "../loader";

const OpenClawMemoryRecallConfigSchema = z
  .object({
    baseDir: z.string().default("~/.mozi"),
    memoryFile: z.string().default("MEMORY.md"),
    maxItems: z.number().int().min(1).max(8).default(3),
    minPromptChars: z.number().int().min(1).max(200).default(5),
    maxInjectChars: z.number().int().min(100).max(8000).default(1200),
    minLineChars: z.number().int().min(4).max(400).default(8),
  })
  .strict();

type OpenClawMemoryRecallConfig = z.infer<typeof OpenClawMemoryRecallConfigSchema>;

type FileCacheEntry = {
  mtimeMs: number;
  lines: string[];
};

function parseConfig(raw: Record<string, unknown>): OpenClawMemoryRecallConfig {
  const parsed = OpenClawMemoryRecallConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return OpenClawMemoryRecallConfigSchema.parse({});
  }
  return parsed.data;
}

function expandHomePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveMemoryFilePath(cfg: OpenClawMemoryRecallConfig, agentId: string): string {
  const rawMemoryFile = cfg.memoryFile.trim();
  const expandedMemoryFile = expandHomePath(rawMemoryFile);
  if (path.isAbsolute(expandedMemoryFile)) {
    return expandedMemoryFile;
  }
  const baseDir = expandHomePath(cfg.baseDir.trim() || "~/.mozi");
  const memoryFile = rawMemoryFile.includes("{agentId}")
    ? rawMemoryFile.replaceAll("{agentId}", agentId)
    : rawMemoryFile;
  const agentHomeDir = path.join(baseDir, "agents", agentId, "home");
  return path.join(agentHomeDir, memoryFile);
}

function extractCandidateLines(rawContent: string, minLineChars: number): string[] {
  const lines = rawContent.split(/\r?\n/);
  const seen = new Set<string>();
  const results: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("#") || trimmed.startsWith("```")) {
      continue;
    }
    const normalized = trimmed.replace(/^(?:[-*]|\d+\.)\s+/, "").trim();
    if (normalized.length < minLineChars) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
  }
  return results;
}

function tokenizeAscii(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
}

function tokenizeCjk(text: string): string[] {
  const sequences = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const tokens: string[] = [];
  for (const sequence of sequences) {
    tokens.push(sequence);
    const maxWindow = Math.min(3, sequence.length);
    for (let windowSize = 2; windowSize <= maxWindow; windowSize += 1) {
      for (let index = 0; index <= sequence.length - windowSize; index += 1) {
        tokens.push(sequence.slice(index, index + windowSize));
      }
    }
  }
  return tokens;
}

function tokenize(text: string): Set<string> {
  const tokens = [...tokenizeAscii(text), ...tokenizeCjk(text)].map((token) => token.trim());
  return new Set(tokens.filter(Boolean));
}

function scoreLine(promptTokens: Set<string>, line: string): number {
  if (promptTokens.size === 0) {
    return 0;
  }
  const lineTokens = tokenize(line);
  if (lineTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of lineTokens) {
    if (promptTokens.has(token)) {
      overlap += 1;
    }
  }
  if (overlap === 0) {
    return 0;
  }
  return overlap / Math.max(lineTokens.size, 1);
}

function selectRelevantLines(params: {
  promptText: string;
  lines: string[];
  maxItems: number;
}): string[] {
  const promptTokens = tokenize(params.promptText);
  if (promptTokens.size === 0) {
    return [];
  }
  return params.lines
    .map((line, index) => ({ line, index, score: scoreLine(promptTokens, line) }))
    .filter((entry) => entry.score > 0)
    .toSorted((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.index - left.index;
    })
    .slice(0, params.maxItems)
    .map((entry) => entry.line);
}

function buildInjectBlock(lines: string[], maxInjectChars: number): string {
  const header = "[Relevant memory from MEMORY.md]";
  const selected: string[] = [];
  let totalChars = header.length;
  for (const line of lines) {
    const bullet = `- ${line.replace(/\s+/g, " ").trim()}`;
    const nextChars = totalChars + 1 + bullet.length;
    if (nextChars > maxInjectChars) {
      break;
    }
    selected.push(bullet);
    totalChars = nextChars;
  }
  if (selected.length === 0) {
    return "";
  }
  return `${header}\n${selected.join("\n")}`;
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function createBeforeAgentStartHandler(cfg: OpenClawMemoryRecallConfig) {
  const cache = new Map<string, FileCacheEntry>();
  return async (
    event: { promptText: string },
    ctx: { agentId?: string },
  ): Promise<{ promptText?: string } | void> => {
    const promptText = event.promptText?.trim();
    if (!promptText || promptText.length < cfg.minPromptChars) {
      return;
    }
    const agentId = ctx.agentId?.trim();
    if (!agentId) {
      return;
    }

    const memoryPath = resolveMemoryFilePath(cfg, agentId);

    let stat;
    try {
      stat = await fs.stat(memoryPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      return;
    }

    const cached = cache.get(memoryPath);
    let lines: string[];
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      lines = cached.lines;
    } else {
      try {
        const raw = await fs.readFile(memoryPath, "utf-8");
        lines = extractCandidateLines(raw, cfg.minLineChars);
      } catch (error) {
        if (isNotFoundError(error)) {
          return;
        }
        return;
      }
      cache.set(memoryPath, { mtimeMs: stat.mtimeMs, lines });
    }

    if (lines.length === 0) {
      return;
    }

    const relevantLines = selectRelevantLines({
      promptText,
      lines,
      maxItems: cfg.maxItems,
    });
    if (relevantLines.length === 0) {
      return;
    }

    const injectBlock = buildInjectBlock(relevantLines, cfg.maxInjectChars);
    if (!injectBlock) {
      return;
    }

    return {
      promptText: `${injectBlock}\n\n${event.promptText}`,
    };
  };
}

function createOpenClawMemoryRecallExtension(_config: Record<string, unknown>): ExtensionManifest {
  return {
    id: "openclaw-memory-recall",
    version: "1.0.0",
    name: "OpenClaw Memory Recall (Lite)",
    description:
      "Migrates OpenClaw memory-lancedb auto-recall pattern: inject relevant MEMORY.md snippets before agent start.",
    configSchema: OpenClawMemoryRecallConfigSchema,
    capabilities: {
      hooks: true,
    },
    register(api) {
      const cfg = parseConfig(api.extensionConfig);
      api.registerHook("before_agent_start", createBeforeAgentStartHandler(cfg), {
        id: "openclaw-memory-recall:before_agent_start",
        priority: 200,
      });
    },
  };
}

registerBuiltinExtension("openclaw-memory-recall", createOpenClawMemoryRecallExtension);

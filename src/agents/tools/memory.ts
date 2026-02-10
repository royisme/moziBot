import { z } from "zod";
import type { MemorySearchManager, ReadFileResult, MemorySearchResult } from "../../memory/types";

export interface MemoryToolsContext {
  manager: MemorySearchManager;
  sessionKey: string;
  onSearchRequested?: () => Promise<void>;
}

export const memorySearchSchema = z.object({
  query: z.string(),
  maxResults: z.number().optional(),
  minScore: z.number().optional(),
});

export async function memorySearch(
  ctx: MemoryToolsContext,
  params: z.infer<typeof memorySearchSchema>,
): Promise<{ results: MemorySearchResult[]; error?: string; backend?: string }> {
  try {
    await ctx.onSearchRequested?.();
    const results = await ctx.manager.search(params.query, {
      maxResults: params.maxResults,
      minScore: params.minScore,
      sessionKey: ctx.sessionKey,
    });
    const status = ctx.manager.status();
    return {
      results,
      backend: status.backend,
    };
  } catch (err) {
    const status = ctx.manager.status();
    return {
      results: [],
      error: err instanceof Error ? err.message : String(err),
      backend: status.backend,
    };
  }
}

export const memoryGetSchema = z.object({
  path: z.string(),
  from: z.number().optional(),
  lines: z.number().optional(),
});

export async function memoryGet(
  ctx: MemoryToolsContext,
  params: z.infer<typeof memoryGetSchema>,
): Promise<ReadFileResult> {
  return ctx.manager.readFile({
    relPath: params.path,
    from: params.from,
    lines: params.lines,
  });
}

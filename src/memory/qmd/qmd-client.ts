import { spawn } from "node:child_process";
import { z } from "zod";

export type QmdQueryResult = {
  docid?: string;
  score?: number;
  file?: string;
  snippet?: string;
  body?: string;
};

const QmdQueryResultSchema = z
  .array(
    z
      .object({
        docid: z.string().optional(),
        score: z.number().optional(),
        file: z.string().optional(),
        snippet: z.string().optional(),
        body: z.string().optional(),
      })
      .partial(),
  )
  .default([]);

const QmdCollectionListSchema = z
  .array(z.union([z.string(), z.object({ name: z.string().optional() }).strict()]))
  .default([]);

export type QmdRunResult = { stdout: string; stderr: string };

export async function runQmd(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
}): Promise<QmdRunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      env: params.env,
      cwd: params.cwd,
    });
    let stdout = "";
    let stderr = "";
    const timer = params.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`qmd ${params.args.join(" ")} timed out after ${params.timeoutMs}ms`));
        }, params.timeoutMs)
      : null;
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(`qmd ${params.args.join(" ")} failed (code ${code}): ${stderr || stdout}`),
        );
      }
    });
  });
}

export function parseCollectionList(stdout: string): Set<string> {
  const existing = new Set<string>();
  const parsed = QmdCollectionListSchema.safeParse(JSON.parse(stdout));
  if (!parsed.success) {
    return existing;
  }
  for (const entry of parsed.data) {
    if (typeof entry === "string") {
      existing.add(entry);
    } else if (entry && typeof entry === "object") {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string") {
        existing.add(name);
      }
    }
  }
  return existing;
}

export function parseQueryResults(stdout: string): QmdQueryResult[] {
  const raw = JSON.parse(stdout);
  const validated = QmdQueryResultSchema.safeParse(raw);
  if (!validated.success) {
    throw new Error(validated.error.message);
  }
  return validated.data;
}

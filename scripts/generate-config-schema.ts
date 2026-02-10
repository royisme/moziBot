import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toJSONSchema } from "zod";
import { MoziConfigSchema } from "../src/config/schema";

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

function sortKeysDeep(value: unknown): JsonLike {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, JsonLike> = {};
    const keys: string[] = [];
    for (const key of Object.keys(input)) {
      let insertAt = 0;
      while (insertAt < keys.length && keys[insertAt].localeCompare(key) <= 0) {
        insertAt += 1;
      }
      keys.splice(insertAt, 0, key);
    }
    for (const key of keys) {
      out[key] = sortKeysDeep(input[key]);
    }
    return out;
  }
  return null;
}

async function main(): Promise<void> {
  const schema = toJSONSchema(MoziConfigSchema, {
    target: "draft-2020-12",
    unrepresentable: "any",
    io: "input",
    reused: "ref",
    cycles: "ref",
  });

  const normalized = sortKeysDeep(schema) as Record<string, JsonLike>;
  normalized["$schema"] = "https://json-schema.org/draft/2020-12/schema";
  normalized["$id"] = "https://mozi.dev/schema/config.schema.json";
  normalized["title"] = "MoziConfig";

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, "..");
  const outDir = path.join(projectRoot, "schema");
  const outPath = path.join(outDir, "config.schema.json");

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  await runFormatter(outPath);
  // biome-ignore lint/suspicious/noConsole: CLI generation script
  console.log(`Generated ${path.relative(projectRoot, outPath)}`);
}

function runFormatter(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("pnpm", ["run", "format:fix", filePath], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`format:fix failed for ${filePath} with code ${code ?? "unknown"}`));
    });
  });
}

await main();

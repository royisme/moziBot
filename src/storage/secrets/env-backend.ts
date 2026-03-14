import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseDotEnv } from "dotenv";
import type { SecretBackend, SecretScope } from "./types";

const DEFAULT_SCOPE: SecretScope = { type: "global" };

function getEnvFilePath(): string {
  return path.join(os.homedir(), ".mozi", ".env");
}

function toEnvKey(key: string, scope: SecretScope): string {
  if (scope.type === "agent") {
    return `MOZI_AGENT_${scope.agentId}_${key}`;
  }
  return key;
}

async function readEnvMap(envFilePath: string): Promise<Map<string, string>> {
  try {
    const raw = await fs.readFile(envFilePath, "utf8");
    const parsed = parseDotEnv(raw);
    return new Map(Object.entries(parsed));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

async function writeEnvMap(envFilePath: string, values: Map<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(envFilePath), { recursive: true });
  const tempFilePath = `${envFilePath}.tmp-${process.pid}-${Date.now()}`;
  const content = Array.from(values.entries())
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");
  const normalizedContent = content.length > 0 ? `${content}\n` : "";
  await fs.writeFile(tempFilePath, normalizedContent, "utf8");
  await fs.rename(tempFilePath, envFilePath);
}

export class EnvSecretBackend implements SecretBackend {
  constructor(private readonly envFilePath = getEnvFilePath()) {}

  async get(key: string, scope: SecretScope = DEFAULT_SCOPE): Promise<string | undefined> {
    const values = await readEnvMap(this.envFilePath);
    return values.get(toEnvKey(key, scope));
  }

  async set(key: string, value: string, scope: SecretScope = DEFAULT_SCOPE): Promise<void> {
    const values = await readEnvMap(this.envFilePath);
    values.set(toEnvKey(key, scope), value);
    await writeEnvMap(this.envFilePath, values);
  }

  async delete(key: string, scope: SecretScope = DEFAULT_SCOPE): Promise<void> {
    const values = await readEnvMap(this.envFilePath);
    values.delete(toEnvKey(key, scope));
    await writeEnvMap(this.envFilePath, values);
  }

  async list(scope: SecretScope = DEFAULT_SCOPE): Promise<string[]> {
    const values = await readEnvMap(this.envFilePath);
    const prefix = scope.type === "agent" ? `MOZI_AGENT_${scope.agentId}_` : undefined;
    const keys: string[] = [];

    for (const key of values.keys()) {
      if (prefix) {
        if (key.startsWith(prefix)) {
          keys.push(key.slice(prefix.length));
        }
        continue;
      }
      if (!key.startsWith("MOZI_AGENT_")) {
        keys.push(key);
      }
    }

    return keys.toSorted((left, right) => left.localeCompare(right));
  }

  async has(key: string, scope: SecretScope = DEFAULT_SCOPE): Promise<boolean> {
    const value = await this.get(key, scope);
    return value !== undefined;
  }
}

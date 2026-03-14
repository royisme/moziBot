import { EnvSecretBackend } from "./env-backend";
import { SqliteSecretBackend } from "./sqlite-backend";
import type { SecretBackend, SecretManager, SecretScope } from "./types";

const GLOBAL_SCOPE: SecretScope = { type: "global" };

export class CompositeSecretManager implements SecretManager {
  constructor(
    private readonly envBackend: SecretBackend = new EnvSecretBackend(),
    private readonly sqliteBackend: SecretBackend = new SqliteSecretBackend(),
  ) {}

  async get(key: string, scope: SecretScope = GLOBAL_SCOPE): Promise<string | undefined> {
    const envValue = await this.envBackend.get(key, scope);
    if (envValue !== undefined) {
      return envValue;
    }
    return this.sqliteBackend.get(key, scope);
  }

  async getEffective(key: string, agentId?: string): Promise<string | undefined> {
    const scopes: SecretScope[] = agentId
      ? [{ type: "agent", agentId }, GLOBAL_SCOPE, { type: "agent", agentId }, GLOBAL_SCOPE]
      : [GLOBAL_SCOPE, GLOBAL_SCOPE];

    const backends: SecretBackend[] = agentId
      ? [this.envBackend, this.envBackend, this.sqliteBackend, this.sqliteBackend]
      : [this.envBackend, this.sqliteBackend];

    for (const [index, backend] of backends.entries()) {
      const value = await backend.get(key, scopes[index]);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  }

  async set(key: string, value: string, scope: SecretScope = GLOBAL_SCOPE): Promise<void> {
    await this.envBackend.set(key, value, scope);
  }

  async delete(key: string, scope: SecretScope = GLOBAL_SCOPE): Promise<void> {
    await this.envBackend.delete(key, scope);
    await this.sqliteBackend.delete(key, scope);
  }

  async list(scope: SecretScope = GLOBAL_SCOPE): Promise<string[]> {
    const keys = [
      ...(await this.sqliteBackend.list(scope)),
      ...(await this.envBackend.list(scope)),
    ];
    return Array.from(new Set(keys)).toSorted((left, right) => left.localeCompare(right));
  }

  async has(key: string, scope: SecretScope = GLOBAL_SCOPE): Promise<boolean> {
    return (await this.get(key, scope)) !== undefined;
  }
}

export function createSecretManager(params?: {
  envBackend?: SecretBackend;
  sqliteBackend?: SecretBackend;
}): SecretManager {
  return new CompositeSecretManager(params?.envBackend, params?.sqliteBackend);
}

import { decryptSecret, resolveMasterKey } from "../../runtime/auth/crypto";
import { authSecrets } from "../repos/auth-secrets";
import type { AuthSecret } from "../types";
import type { SecretBackend, SecretScope } from "./types";

const DEFAULT_SCOPE: SecretScope = { type: "global" };

function toRepoScope(scope: SecretScope): { scopeType: "global" | "agent"; scopeId?: string } {
  if (scope.type === "agent") {
    return { scopeType: "agent", scopeId: scope.agentId };
  }
  return { scopeType: "global" };
}

function toSecretKey(row: AuthSecret, scope: SecretScope): string | undefined {
  if (scope.type === "agent") {
    return row.scope_type === "agent" && row.scope_id === scope.agentId ? row.name : undefined;
  }
  return row.scope_type === "global" && row.scope_id === "" ? row.name : undefined;
}

function decryptRow(row: AuthSecret, masterKeyEnv: string): string {
  const masterKey = resolveMasterKey(masterKeyEnv);
  return decryptSecret(row.value_ciphertext, row.value_nonce, masterKey);
}

export class SqliteSecretBackend implements SecretBackend {
  constructor(private readonly masterKeyEnv = "MOZI_MASTER_KEY") {}

  async get(key: string, scope: SecretScope = DEFAULT_SCOPE): Promise<string | undefined> {
    const normalizedScope = toRepoScope(scope);
    const row = authSecrets.getExact({
      name: key,
      scopeType: normalizedScope.scopeType,
      scopeId: normalizedScope.scopeId,
    });
    return row ? decryptRow(row, this.masterKeyEnv) : undefined;
  }

  async set(): Promise<void> {
    throw new Error("SQLite backend is read-only in M1");
  }

  async delete(): Promise<void> {
    throw new Error("SQLite backend is read-only in M1");
  }

  async list(scope: SecretScope = DEFAULT_SCOPE): Promise<string[]> {
    const rows = authSecrets.list();
    const keys = rows
      .map((row) => toSecretKey(row, scope))
      .filter((key): key is string => key !== undefined)
      .toSorted((left, right) => left.localeCompare(right));
    return Array.from(new Set(keys));
  }

  async has(key: string, scope: SecretScope = DEFAULT_SCOPE): Promise<boolean> {
    const value = await this.get(key, scope);
    return value !== undefined;
  }
}

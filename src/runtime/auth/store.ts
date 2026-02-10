import type { SecretRecordMeta, SecretScope, SecretStore, SecretStoreRecord } from "./types";
import { authSecrets } from "../../storage/db";

function toScope(scopeType: "global" | "agent", scopeId: string | null): SecretScope {
  if (scopeType === "agent") {
    return { type: "agent", agentId: scopeId || "" };
  }
  return { type: "global" };
}

function normalizeScope(scope: SecretScope): { scopeType: "global" | "agent"; scopeId?: string } {
  if (scope.type === "agent") {
    return { scopeType: "agent", scopeId: scope.agentId };
  }
  return { scopeType: "global" };
}

export class SqliteSecretStore implements SecretStore {
  async upsert(params: {
    name: string;
    scope: SecretScope;
    ciphertext: Buffer;
    nonce: Buffer;
    actor?: string;
  }): Promise<void> {
    const scope = normalizeScope(params.scope);
    authSecrets.upsert({
      name: params.name,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      valueCiphertext: params.ciphertext,
      valueNonce: params.nonce,
      createdBy: params.actor,
    });
  }

  async delete(params: { name: string; scope: SecretScope }): Promise<boolean> {
    const scope = normalizeScope(params.scope);
    return authSecrets.delete({
      name: params.name,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
    });
  }

  async list(params: { scope?: SecretScope }): Promise<SecretRecordMeta[]> {
    const rows = params.scope
      ? authSecrets.list({
          scopeType: normalizeScope(params.scope).scopeType,
          scopeId: normalizeScope(params.scope).scopeId,
        })
      : authSecrets.list();
    return rows.map((row) => ({
      name: row.name,
      scope: toScope(row.scope_type, row.scope_id),
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at || undefined,
    }));
  }

  async getExact(params: { name: string; scope: SecretScope }): Promise<SecretStoreRecord | null> {
    const scope = normalizeScope(params.scope);
    const row = authSecrets.getExact({
      name: params.name,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
    });
    if (!row) {
      return null;
    }
    return {
      ciphertext: row.value_ciphertext,
      nonce: row.value_nonce,
      scope: toScope(row.scope_type, row.scope_id),
    };
  }

  async getEffective(params: { name: string; agentId: string }): Promise<SecretStoreRecord | null> {
    const row = authSecrets.getEffective({ name: params.name, agentId: params.agentId });
    if (!row) {
      return null;
    }
    return {
      ciphertext: row.value_ciphertext,
      nonce: row.value_nonce,
      scope: toScope(row.scope_type, row.scope_id),
    };
  }

  async touchLastUsed(params: { name: string; scope: SecretScope }): Promise<void> {
    const scope = normalizeScope(params.scope);
    authSecrets.touchLastUsed({
      name: params.name,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
    });
  }
}

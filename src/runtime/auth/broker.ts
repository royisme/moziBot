import type { SecretBroker, SecretScope, SecretStore } from "./types";
import { decryptSecret, encryptSecret, resolveMasterKey } from "./crypto";
import { SqliteSecretStore } from "./store";

export class RuntimeSecretBroker implements SecretBroker {
  constructor(
    private readonly store: SecretStore,
    private readonly masterKeyEnv: string,
  ) {}

  async set(params: {
    name: string;
    value: string;
    scope: SecretScope;
    actor?: string;
  }): Promise<void> {
    const masterKey = resolveMasterKey(this.masterKeyEnv);
    const encrypted = encryptSecret(params.value, masterKey);
    await this.store.upsert({
      name: params.name,
      scope: params.scope,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      actor: params.actor,
    });
  }

  async unset(params: { name: string; scope: SecretScope }): Promise<boolean> {
    return this.store.delete(params);
  }

  async list(params: { scope?: SecretScope }) {
    return this.store.list(params);
  }

  async check(params: {
    name: string;
    agentId: string;
    scope?: SecretScope;
  }): Promise<{ exists: boolean; scope?: SecretScope }> {
    if (params.scope) {
      const exact = await this.store.getExact({ name: params.name, scope: params.scope });
      return exact ? { exists: true, scope: exact.scope } : { exists: false };
    }
    const effective = await this.store.getEffective({ name: params.name, agentId: params.agentId });
    return effective ? { exists: true, scope: effective.scope } : { exists: false };
  }

  async getValue(params: {
    name: string;
    agentId: string;
    scope?: SecretScope;
  }): Promise<string | null> {
    const masterKey = resolveMasterKey(this.masterKeyEnv);
    const record = params.scope
      ? await this.store.getExact({ name: params.name, scope: params.scope })
      : await this.store.getEffective({ name: params.name, agentId: params.agentId });
    if (!record) {
      return null;
    }
    const value = decryptSecret(record.ciphertext, record.nonce, masterKey);
    await this.store.touchLastUsed({ name: params.name, scope: record.scope });
    return value;
  }
}

export function createRuntimeSecretBroker(params?: {
  masterKeyEnv?: string;
  store?: SecretStore;
}): RuntimeSecretBroker {
  const store = params?.store ?? new SqliteSecretStore();
  return new RuntimeSecretBroker(store, params?.masterKeyEnv ?? "MOZI_MASTER_KEY");
}

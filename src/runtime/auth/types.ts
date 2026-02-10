export type SecretScope = { type: "global" } | { type: "agent"; agentId: string };

export interface SecretRecordMeta {
  name: string;
  scope: SecretScope;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface SecretStoreRecord {
  ciphertext: Buffer;
  nonce: Buffer;
  scope: SecretScope;
}

export interface SecretStore {
  upsert(params: {
    name: string;
    scope: SecretScope;
    ciphertext: Buffer;
    nonce: Buffer;
    actor?: string;
  }): Promise<void>;
  delete(params: { name: string; scope: SecretScope }): Promise<boolean>;
  list(params: { scope?: SecretScope }): Promise<SecretRecordMeta[]>;
  getExact(params: { name: string; scope: SecretScope }): Promise<SecretStoreRecord | null>;
  getEffective(params: { name: string; agentId: string }): Promise<SecretStoreRecord | null>;
  touchLastUsed(params: { name: string; scope: SecretScope }): Promise<void>;
}

export interface SecretBroker {
  set(params: { name: string; value: string; scope: SecretScope; actor?: string }): Promise<void>;
  unset(params: { name: string; scope: SecretScope }): Promise<boolean>;
  list(params: { scope?: SecretScope }): Promise<SecretRecordMeta[]>;
  check(params: {
    name: string;
    agentId: string;
    scope?: SecretScope;
  }): Promise<{ exists: boolean; scope?: SecretScope }>;
}

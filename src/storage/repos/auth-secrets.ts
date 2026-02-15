import { withConnection } from "../connection";
import type { AuthSecret } from "../types";

export const authSecrets = {
  upsert: (secret: {
    name: string;
    scopeType: "global" | "agent";
    scopeId?: string;
    valueCiphertext: Buffer;
    valueNonce: Buffer;
    createdBy?: string;
  }) => {
    return withConnection((conn) => {
      const now = new Date().toISOString();
      conn
        .prepare(
          `INSERT INTO auth_secrets (name, scope_type, scope_id, value_ciphertext, value_nonce, created_at, updated_at, last_used_at, created_by)
           VALUES ($name, $scope_type, $scope_id, $value_ciphertext, $value_nonce, $created_at, $updated_at, NULL, $created_by)
           ON CONFLICT(scope_type, scope_id, name)
           DO UPDATE SET value_ciphertext = excluded.value_ciphertext, value_nonce = excluded.value_nonce, updated_at = excluded.updated_at, created_by = excluded.created_by`,
        )
        .run({
          name: secret.name,
          scope_type: secret.scopeType,
          scope_id: secret.scopeId ?? "",
          value_ciphertext: secret.valueCiphertext,
          value_nonce: secret.valueNonce,
          created_at: now,
          updated_at: now,
          created_by: secret.createdBy ?? null,
        });
    });
  },
  delete: (params: { name: string; scopeType: "global" | "agent"; scopeId?: string }): boolean => {
    return withConnection(
      (conn) =>
        conn
          .prepare(
            `DELETE FROM auth_secrets WHERE name = $name AND scope_type = $scope_type AND scope_id = $scope_id`,
          )
          .run({
            name: params.name,
            scope_type: params.scopeType,
            scope_id: params.scopeId ?? "",
          }).changes > 0,
    );
  },
  list: (params?: { scopeType?: "global" | "agent"; scopeId?: string }): AuthSecret[] => {
    return withConnection((conn) => {
      if (!params?.scopeType) {
        return conn
          .prepare(`SELECT * FROM auth_secrets ORDER BY scope_type ASC, scope_id ASC, name ASC`)
          .all() as AuthSecret[];
      }
      return conn
        .prepare(
          `SELECT * FROM auth_secrets WHERE scope_type = $scope_type AND scope_id = $scope_id ORDER BY name ASC`,
        )
        .all({
          scope_type: params.scopeType,
          scope_id: params.scopeId ?? "",
        }) as AuthSecret[];
    });
  },
  getExact: (params: {
    name: string;
    scopeType: "global" | "agent";
    scopeId?: string;
  }): AuthSecret | null => {
    return withConnection(
      (conn) =>
        (conn
          .prepare(
            `SELECT * FROM auth_secrets WHERE name = $name AND scope_type = $scope_type AND scope_id = $scope_id`,
          )
          .get({
            name: params.name,
            scope_type: params.scopeType,
            scope_id: params.scopeId ?? "",
          }) as AuthSecret | undefined) ?? null,
    );
  },
  getEffective: (params: { name: string; agentId: string }): AuthSecret | null => {
    return withConnection((conn) => {
      const agentScoped = conn
        .prepare(
          `SELECT * FROM auth_secrets WHERE name = $name AND scope_type = 'agent' AND scope_id = $scope_id LIMIT 1`,
        )
        .get({ name: params.name, scope_id: params.agentId }) as AuthSecret | undefined;
      if (agentScoped) {
        return agentScoped;
      }
      return (
        (conn
          .prepare(
            `SELECT * FROM auth_secrets WHERE name = $name AND scope_type = 'global' AND scope_id = '' LIMIT 1`,
          )
          .get({ name: params.name }) as AuthSecret | undefined) ?? null
      );
    });
  },
  touchLastUsed: (params: { name: string; scopeType: "global" | "agent"; scopeId?: string }) => {
    return withConnection((conn) => {
      const now = new Date().toISOString();
      conn
        .prepare(
          `UPDATE auth_secrets SET last_used_at = $last_used_at, updated_at = $updated_at WHERE name = $name AND scope_type = $scope_type AND scope_id = $scope_id`,
        )
        .run({
          last_used_at: now,
          updated_at: now,
          name: params.name,
          scope_type: params.scopeType,
          scope_id: params.scopeId ?? "",
        });
    });
  },
};

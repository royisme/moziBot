import type { MoziConfig } from "../../config/schema";
import type { SessionAcpMeta } from "../types";
import { ACP_ERROR_CODES, AcpRuntimeError } from "../runtime/errors";

export function resolveAcpAgentFromSessionKey(sessionKey: string, fallback = "main"): string {
  // Session keys have format: agent:{agentId}:...
  const parts = sessionKey.split(":");
  const agentId = parts.length > 1 ? parts[1] : undefined;
  const resolved = agentId?.trim() || fallback;
  return resolved.trim().toLowerCase();
}

export function resolveMissingMetaError(sessionKey: string): AcpRuntimeError {
  return new AcpRuntimeError(
    "ACP_SESSION_INIT_FAILED",
    `ACP metadata is missing for ${sessionKey}. Recreate this ACP session with /acp spawn and rebind the thread.`,
  );
}

export function normalizeSessionKey(sessionKey: string): string {
  return sessionKey.trim();
}

export function normalizeActorKey(sessionKey: string): string {
  return sessionKey.trim().toLowerCase();
}

export function normalizeAcpErrorCode(code: string | undefined): AcpRuntimeError["code"] {
  if (!code) {
    return "ACP_TURN_FAILED";
  }
  const normalized = code.trim().toUpperCase();
  for (const allowed of ACP_ERROR_CODES) {
    if (allowed === normalized) {
      return allowed;
    }
  }
  return "ACP_TURN_FAILED";
}

export function createUnsupportedControlError(params: {
  backend: string;
  control: string;
}): AcpRuntimeError {
  return new AcpRuntimeError(
    "ACP_BACKEND_UNSUPPORTED_CONTROL",
    `ACP backend "${params.backend}" does not support ${params.control}.`,
  );
}

export function resolveRuntimeIdleTtlMs(cfg: MoziConfig): number {
  const ttlMinutes = cfg.acp?.runtime?.ttlMinutes;
  if (typeof ttlMinutes !== "number" || !Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    return 0;
  }
  return Math.round(ttlMinutes * 60 * 1000);
}

export function hasLegacyAcpIdentityProjection(meta: SessionAcpMeta): boolean {
  const raw = meta as Record<string, unknown>;
  return (
    Object.hasOwn(raw, "backendSessionId") ||
    Object.hasOwn(raw, "agentSessionId") ||
    Object.hasOwn(raw, "sessionIdsProvisional")
  );
}

import type { MoziConfig } from "../config/schema";
import {
  isAcpDispatchEnabledByPolicy,
  isAcpEnabledByPolicy,
  resolveAcpDispatchPolicyMessage,
  resolveAcpDispatchPolicyState,
  type AcpDispatchPolicyState,
} from "../config/schema/acp-policy";
import { AcpRuntimeError } from "./runtime/errors";

function normalizeAgentId(id: string): string {
  return id.trim().toLowerCase();
}

export {
  isAcpDispatchEnabledByPolicy,
  isAcpEnabledByPolicy,
  resolveAcpDispatchPolicyMessage,
  resolveAcpDispatchPolicyState,
  type AcpDispatchPolicyState,
};

export function resolveAcpDispatchPolicyError(cfg: MoziConfig): AcpRuntimeError | null {
  const message = resolveAcpDispatchPolicyMessage(cfg);
  if (!message) {
    return null;
  }
  return new AcpRuntimeError("ACP_DISPATCH_DISABLED", message);
}

export function isAcpAgentAllowedByPolicy(cfg: MoziConfig, agentId: string): boolean {
  const allowed = (cfg.acp?.allowedAgents ?? [])
    .map((entry) => normalizeAgentId(entry))
    .filter(Boolean);
  if (allowed.length === 0) {
    return true;
  }
  return allowed.includes(normalizeAgentId(agentId));
}

export function resolveAcpAgentPolicyError(
  cfg: MoziConfig,
  agentId: string,
): AcpRuntimeError | null {
  if (isAcpAgentAllowedByPolicy(cfg, agentId)) {
    return null;
  }
  return new AcpRuntimeError(
    "ACP_SESSION_INIT_FAILED",
    `ACP agent "${normalizeAgentId(agentId)}" is not allowed by policy.`,
  );
}

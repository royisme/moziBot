import type { MoziConfig } from "./index";

const ACP_DISABLED_MESSAGE = "ACP is disabled by policy (`acp.enabled=false`).";
const ACP_DISPATCH_DISABLED_MESSAGE =
  "ACP dispatch is disabled by policy (`acp.dispatch.enabled=false`).";

export type AcpDispatchPolicyState = "enabled" | "acp_disabled" | "dispatch_disabled";

export function isAcpEnabledByPolicy(cfg: MoziConfig): boolean {
  return cfg.acp?.enabled !== false;
}

export function resolveAcpDispatchPolicyState(cfg: MoziConfig): AcpDispatchPolicyState {
  if (!isAcpEnabledByPolicy(cfg)) {
    return "acp_disabled";
  }
  if (cfg.acp?.dispatch?.enabled !== true) {
    return "dispatch_disabled";
  }
  return "enabled";
}

export function isAcpDispatchEnabledByPolicy(cfg: MoziConfig): boolean {
  return resolveAcpDispatchPolicyState(cfg) === "enabled";
}

export function resolveAcpDispatchPolicyMessage(cfg: MoziConfig): string | null {
  const state = resolveAcpDispatchPolicyState(cfg);
  if (state === "acp_disabled") {
    return ACP_DISABLED_MESSAGE;
  }
  if (state === "dispatch_disabled") {
    return ACP_DISPATCH_DISABLED_MESSAGE;
  }
  return null;
}

export function resolveAcpDispatchPolicyError(cfg: MoziConfig): Error | null {
  const message = resolveAcpDispatchPolicyMessage(cfg);
  if (!message) {
    return null;
  }
  return new Error(message);
}

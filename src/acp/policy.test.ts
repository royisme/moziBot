import { describe, expect, it } from "vitest";
import type { MoziConfig } from "../config/schema";
import {
  isAcpEnabledByPolicy,
  resolveAcpDispatchPolicyState,
  isAcpDispatchEnabledByPolicy,
  resolveAcpDispatchPolicyMessage,
  resolveAcpDispatchPolicyError,
  isAcpAgentAllowedByPolicy,
  resolveAcpAgentPolicyError,
  type AcpDispatchPolicyState,
} from "./policy";
import { AcpRuntimeError } from "./runtime/errors";

function createMockConfig(overrides?: {
  enabled?: boolean;
  dispatchEnabled?: boolean;
  legacyDispatchEnabled?: boolean;
  allowedAgents?: string[];
}): MoziConfig {
  return {
    acp: {
      enabled: overrides?.enabled,
      dispatch: {
        enabled: overrides?.dispatchEnabled,
      },
      dispatchEnabled: overrides?.legacyDispatchEnabled,
      allowedAgents: overrides?.allowedAgents,
    },
  } as MoziConfig;
}

describe("ACP Policy Helpers", () => {
  describe("isAcpEnabledByPolicy", () => {
    it("should return true when acp.enabled is not set (default)", () => {
      const cfg = {} as MoziConfig;
      expect(isAcpEnabledByPolicy(cfg)).toBe(true);
    });

    it("should return true when acp.enabled is true", () => {
      const cfg = createMockConfig({ enabled: true });
      expect(isAcpEnabledByPolicy(cfg)).toBe(true);
    });

    it("should return false when acp.enabled is false", () => {
      const cfg = createMockConfig({ enabled: false });
      expect(isAcpEnabledByPolicy(cfg)).toBe(false);
    });

    it("should return true when acp is undefined", () => {
      const cfg = { acp: undefined } as unknown as MoziConfig;
      expect(isAcpEnabledByPolicy(cfg)).toBe(true);
    });
  });

  describe("resolveAcpDispatchPolicyState", () => {
    it("should return 'enabled' when both acp and dispatch are enabled", () => {
      const cfg = createMockConfig({ enabled: true, dispatchEnabled: true });
      expect(resolveAcpDispatchPolicyState(cfg)).toBe("enabled");
    });

    it("should return 'acp_disabled' when acp is disabled", () => {
      const cfg = createMockConfig({ enabled: false, dispatchEnabled: true });
      expect(resolveAcpDispatchPolicyState(cfg)).toBe("acp_disabled");
    });

    it("should return 'dispatch_disabled' when dispatch is not enabled", () => {
      const cfg = createMockConfig({ enabled: true, dispatchEnabled: false });
      expect(resolveAcpDispatchPolicyState(cfg)).toBe("dispatch_disabled");
    });

    it("should return 'dispatch_disabled' when dispatch.enabled is undefined", () => {
      const cfg = createMockConfig({ enabled: true });
      expect(resolveAcpDispatchPolicyState(cfg)).toBe("dispatch_disabled");
    });

    it("should use legacy acp.dispatchEnabled when dispatch.enabled is missing", () => {
      const cfg = createMockConfig({ enabled: true, legacyDispatchEnabled: true });
      expect(resolveAcpDispatchPolicyState(cfg)).toBe("enabled");
    });

    it("should prioritize acp_disabled over dispatch_disabled", () => {
      const cfg = createMockConfig({ enabled: false, dispatchEnabled: false });
      expect(resolveAcpDispatchPolicyState(cfg)).toBe("acp_disabled");
    });
  });

  describe("isAcpDispatchEnabledByPolicy", () => {
    it("should return true only when state is 'enabled'", () => {
      expect(
        isAcpDispatchEnabledByPolicy(createMockConfig({ enabled: true, dispatchEnabled: true })),
      ).toBe(true);
      expect(isAcpDispatchEnabledByPolicy(createMockConfig({ enabled: false }))).toBe(false);
      expect(
        isAcpDispatchEnabledByPolicy(createMockConfig({ enabled: true, dispatchEnabled: false })),
      ).toBe(false);
    });
  });

  describe("resolveAcpDispatchPolicyMessage", () => {
    it("should return null when enabled", () => {
      const cfg = createMockConfig({ enabled: true, dispatchEnabled: true });
      expect(resolveAcpDispatchPolicyMessage(cfg)).toBeNull();
    });

    it("should return ACP disabled message", () => {
      const cfg = createMockConfig({ enabled: false });
      const message = resolveAcpDispatchPolicyMessage(cfg);
      expect(message).toContain("acp.enabled=false");
      expect(message).toContain("disabled by policy");
    });

    it("should return dispatch disabled message", () => {
      const cfg = createMockConfig({ enabled: true, dispatchEnabled: false });
      const message = resolveAcpDispatchPolicyMessage(cfg);
      expect(message).toContain("acp.dispatch.enabled=false");
      expect(message).toContain("disabled by policy");
    });
  });

  describe("resolveAcpDispatchPolicyError", () => {
    it("should return null when enabled", () => {
      const cfg = createMockConfig({ enabled: true, dispatchEnabled: true });
      expect(resolveAcpDispatchPolicyError(cfg)).toBeNull();
    });

    it("should return AcpRuntimeError with correct code when disabled", () => {
      const cfg = createMockConfig({ enabled: false });
      const error = resolveAcpDispatchPolicyError(cfg);
      expect(error).toBeInstanceOf(AcpRuntimeError);
      expect(error?.code).toBe("ACP_DISPATCH_DISABLED");
    });

    it("should include message in error", () => {
      const cfg = createMockConfig({ enabled: false });
      const error = resolveAcpDispatchPolicyError(cfg);
      expect(error?.message).toContain("disabled by policy");
    });
  });

  describe("isAcpAgentAllowedByPolicy", () => {
    it("should allow any agent when allowedAgents is empty", () => {
      const cfg = createMockConfig({ allowedAgents: [] });
      expect(isAcpAgentAllowedByPolicy(cfg, "any-agent")).toBe(true);
    });

    it("should allow any agent when allowedAgents is undefined", () => {
      const cfg = createMockConfig();
      expect(isAcpAgentAllowedByPolicy(cfg, "any-agent")).toBe(true);
    });

    it("should allow agent in allowed list", () => {
      const cfg = createMockConfig({ allowedAgents: ["main", "dev"] });
      expect(isAcpAgentAllowedByPolicy(cfg, "main")).toBe(true);
      expect(isAcpAgentAllowedByPolicy(cfg, "dev")).toBe(true);
    });

    it("should deny agent not in allowed list", () => {
      const cfg = createMockConfig({ allowedAgents: ["main"] });
      expect(isAcpAgentAllowedByPolicy(cfg, "unauthorized")).toBe(false);
    });

    it("should normalize agent IDs to lowercase", () => {
      const cfg = createMockConfig({ allowedAgents: ["MAIN", "DEV"] });
      expect(isAcpAgentAllowedByPolicy(cfg, "main")).toBe(true);
      expect(isAcpAgentAllowedByPolicy(cfg, "Main")).toBe(true);
      expect(isAcpAgentAllowedByPolicy(cfg, "dev")).toBe(true);
    });

    it("should filter out empty agent IDs", () => {
      const cfg = createMockConfig({ allowedAgents: ["main", "", "  "] });
      expect(isAcpAgentAllowedByPolicy(cfg, "other")).toBe(false);
      expect(isAcpAgentAllowedByPolicy(cfg, "main")).toBe(true);
    });
  });

  describe("resolveAcpAgentPolicyError", () => {
    it("should return null when agent is allowed", () => {
      const cfg = createMockConfig({ allowedAgents: ["main"] });
      expect(resolveAcpAgentPolicyError(cfg, "main")).toBeNull();
    });

    it("should return AcpRuntimeError when agent is denied", () => {
      const cfg = createMockConfig({ allowedAgents: ["main"] });
      const error = resolveAcpAgentPolicyError(cfg, "unauthorized");
      expect(error).toBeInstanceOf(AcpRuntimeError);
      expect(error?.code).toBe("ACP_SESSION_INIT_FAILED");
    });

    it("should include normalized agent ID in error message", () => {
      const cfg = createMockConfig({ allowedAgents: ["main"] });
      const error = resolveAcpAgentPolicyError(cfg, "UNAUTHORIZED");
      expect(error?.message).toContain('"unauthorized"');
      expect(error?.message).toContain("not allowed by policy");
    });
  });

  describe("policy state exhaustiveness", () => {
    it("should cover all AcpDispatchPolicyState values", () => {
      const states: AcpDispatchPolicyState[] = ["enabled", "acp_disabled", "dispatch_disabled"];
      for (const state of states) {
        let matched = false;
        if (state === "enabled") {
          matched = true;
        }
        if (state === "acp_disabled") {
          matched = true;
        }
        if (state === "dispatch_disabled") {
          matched = true;
        }
        expect(matched).toBe(true);
      }
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  resolveAcpAgentFromSessionKey,
  resolveMissingMetaError,
  normalizeSessionKey,
  normalizeActorKey,
  normalizeAcpErrorCode,
  createUnsupportedControlError,
  resolveRuntimeIdleTtlMs,
  hasLegacyAcpIdentityProjection,
} from "./manager.utils";
import { AcpRuntimeError } from "../runtime/errors";
import type { SessionAcpMeta } from "../types";

describe("manager.utils", () => {
  describe("resolveAcpAgentFromSessionKey", () => {
    it("should extract agent from session key", () => {
      expect(resolveAcpAgentFromSessionKey("agent:main:thread1")).toBe("main");
      expect(resolveAcpAgentFromSessionKey("agent:dev:session")).toBe("dev");
    });

    it("should use fallback when agent cannot be extracted", () => {
      expect(resolveAcpAgentFromSessionKey("invalid", "fallback")).toBe("fallback");
      expect(resolveAcpAgentFromSessionKey("", "default")).toBe("default");
    });

    it("should use 'main' as default fallback", () => {
      expect(resolveAcpAgentFromSessionKey("invalid")).toBe("main");
    });

    it("should normalize agent to lowercase", () => {
      expect(resolveAcpAgentFromSessionKey("agent:MAIN:thread1")).toBe("main");
    });

    it("should handle empty agent in key", () => {
      expect(resolveAcpAgentFromSessionKey("agent::thread1")).toBe("main");
    });
  });

  describe("resolveMissingMetaError", () => {
    it("should create AcpRuntimeError with correct code", () => {
      const error = resolveMissingMetaError("test:main");
      expect(error).toBeInstanceOf(AcpRuntimeError);
      expect(error.code).toBe("ACP_SESSION_INIT_FAILED");
    });

    it("should include session key in message", () => {
      const error = resolveMissingMetaError("test:main");
      expect(error.message).toContain("test:main");
      expect(error.message).toContain("/acp spawn");
    });
  });

  describe("normalizeSessionKey", () => {
    it("should trim whitespace", () => {
      expect(normalizeSessionKey("  test:main  ")).toBe("test:main");
    });

    it("should return same string for already normalized key", () => {
      expect(normalizeSessionKey("test:main")).toBe("test:main");
    });
  });

  describe("normalizeActorKey", () => {
    it("should trim and lowercase", () => {
      expect(normalizeActorKey("  TEST:MAIN  ")).toBe("test:main");
    });

    it("should handle already normalized key", () => {
      expect(normalizeActorKey("test:main")).toBe("test:main");
    });
  });

  describe("normalizeAcpErrorCode", () => {
    it("should return allowed codes unchanged", () => {
      expect(normalizeAcpErrorCode("ACP_TURN_FAILED")).toBe("ACP_TURN_FAILED");
      expect(normalizeAcpErrorCode("ACP_BACKEND_MISSING")).toBe("ACP_BACKEND_MISSING");
      expect(normalizeAcpErrorCode("ACP_SESSION_INIT_FAILED")).toBe("ACP_SESSION_INIT_FAILED");
    });

    it("should normalize case", () => {
      expect(normalizeAcpErrorCode("acp_turn_failed")).toBe("ACP_TURN_FAILED");
    });

    it("should default to ACP_TURN_FAILED for unknown codes", () => {
      expect(normalizeAcpErrorCode("UNKNOWN_CODE")).toBe("ACP_TURN_FAILED");
    });

    it("should default to ACP_TURN_FAILED for undefined", () => {
      expect(normalizeAcpErrorCode(undefined)).toBe("ACP_TURN_FAILED");
    });

    it("should trim whitespace", () => {
      expect(normalizeAcpErrorCode("  ACP_TURN_FAILED  ")).toBe("ACP_TURN_FAILED");
    });
  });

  describe("createUnsupportedControlError", () => {
    it("should create AcpRuntimeError with correct code", () => {
      const error = createUnsupportedControlError({
        backend: "test-backend",
        control: "session/set_mode",
      });
      expect(error).toBeInstanceOf(AcpRuntimeError);
      expect(error.code).toBe("ACP_BACKEND_UNSUPPORTED_CONTROL");
    });

    it("should include backend and control in message", () => {
      const error = createUnsupportedControlError({
        backend: "test-backend",
        control: "session/set_mode",
      });
      expect(error.message).toContain("test-backend");
      expect(error.message).toContain("session/set_mode");
    });
  });

  describe("resolveRuntimeIdleTtlMs", () => {
    it("should convert minutes to milliseconds", () => {
      const cfg = { acp: { runtime: { ttlMinutes: 5 } } } as any;
      expect(resolveRuntimeIdleTtlMs(cfg)).toBe(5 * 60 * 1000);
    });

    it("should return 0 for undefined ttlMinutes", () => {
      const cfg = {} as any;
      expect(resolveRuntimeIdleTtlMs(cfg)).toBe(0);
    });

    it("should return 0 for invalid ttlMinutes", () => {
      expect(resolveRuntimeIdleTtlMs({ acp: { runtime: { ttlMinutes: -1 } } } as any)).toBe(0);
      expect(resolveRuntimeIdleTtlMs({ acp: { runtime: { ttlMinutes: 0 } } } as any)).toBe(0);
      expect(resolveRuntimeIdleTtlMs({ acp: { runtime: { ttlMinutes: "invalid" } } } as any)).toBe(
        0,
      );
    });

    it("should round fractional minutes", () => {
      const cfg = { acp: { runtime: { ttlMinutes: 1.5 } } } as any;
      expect(resolveRuntimeIdleTtlMs(cfg)).toBe(90 * 1000);
    });
  });

  describe("hasLegacyAcpIdentityProjection", () => {
    it("should return false for meta without legacy fields", () => {
      const meta: SessionAcpMeta = {
        backend: "test",
        agent: "main",
        runtimeSessionName: "test",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      };
      expect(hasLegacyAcpIdentityProjection(meta)).toBe(false);
    });

    it("should return true when backendSessionId is present", () => {
      const meta = {
        backend: "test",
        agent: "main",
        runtimeSessionName: "test",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
        backendSessionId: "backend-123",
      } as any;
      expect(hasLegacyAcpIdentityProjection(meta)).toBe(true);
    });

    it("should return true when agentSessionId is present", () => {
      const meta = {
        backend: "test",
        agent: "main",
        runtimeSessionName: "test",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
        agentSessionId: "agent-456",
      } as any;
      expect(hasLegacyAcpIdentityProjection(meta)).toBe(true);
    });

    it("should return true when sessionIdsProvisional is present", () => {
      const meta = {
        backend: "test",
        agent: "main",
        runtimeSessionName: "test",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
        sessionIdsProvisional: ["id1", "id2"],
      } as any;
      expect(hasLegacyAcpIdentityProjection(meta)).toBe(true);
    });
  });
});

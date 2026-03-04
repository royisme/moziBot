import { describe, expect, it } from "vitest";
import type { SessionAcpMeta, SessionAcpError } from "../types";
import { createSessionAcpError, applySessionError, clearSessionError } from "./session-meta";

describe("createSessionAcpError", () => {
  it("should create error with all fields", () => {
    const error = createSessionAcpError({
      message: "Test error",
      code: "TEST_CODE",
      category: "runtime",
      retryable: true,
    });

    expect(error.message).toBe("Test error");
    expect(error.code).toBe("TEST_CODE");
    expect(error.category).toBe("runtime");
    expect(error.retryable).toBe(true);
    expect(error.timestamp).toBeGreaterThan(0);
  });

  it("should create error with minimal fields", () => {
    const error = createSessionAcpError({
      message: "Simple error",
    });

    expect(error.message).toBe("Simple error");
    expect(error.code).toBeUndefined();
    expect(error.category).toBeUndefined();
    expect(error.retryable).toBeUndefined();
    expect(error.timestamp).toBeGreaterThan(0);
  });
});

describe("applySessionError", () => {
  const baseMeta: SessionAcpMeta = {
    backend: "test-backend",
    agent: "test-agent",
    runtimeSessionName: "test-session",
    mode: "persistent",
    state: "running",
    lastActivityAt: Date.now() - 1000,
  };

  it("should return null when current is undefined", () => {
    const result = applySessionError(undefined, "error");
    expect(result).toBeNull();
  });

  it("should apply string error and set terminal state", () => {
    const result = applySessionError(baseMeta, "Something went wrong");

    expect(result).not.toBeNull();
    expect(result!.state).toBe("error");
    expect(result!.lastErrorDetails).toBeDefined();
    expect(result!.lastErrorDetails!.message).toBe("Something went wrong");
    expect(result!.lastActivityAt).toBeGreaterThan(baseMeta.lastActivityAt);
  });

  it("should apply Error instance and extract message", () => {
    const error = new Error("Native error");
    const result = applySessionError(baseMeta, error);

    expect(result).not.toBeNull();
    expect(result!.state).toBe("error");
    expect(result!.lastErrorDetails!.message).toBe("Native error");
  });

  it("should apply structured SessionAcpError", () => {
    const structuredError: SessionAcpError = {
      message: "Structured error",
      code: "STRUCTURED_ERR",
      category: "config",
      retryable: false,
      timestamp: Date.now(),
    };
    const result = applySessionError(baseMeta, structuredError);

    expect(result).not.toBeNull();
    expect(result!.state).toBe("error");
    expect(result!.lastErrorDetails).toEqual(structuredError);
  });

  it("should preserve other meta fields when applying error", () => {
    const metaWithExtras: SessionAcpMeta = {
      ...baseMeta,
      identity: {
        state: "resolved",
        acpxRecordId: "record-123",
        source: "ensure",
        lastUpdatedAt: Date.now(),
      },
      runtimeOptions: {
        model: "gpt-4",
      },
    };

    const result = applySessionError(metaWithExtras, "Error occurred");

    expect(result).not.toBeNull();
    expect(result!.backend).toBe("test-backend");
    expect(result!.agent).toBe("test-agent");
    expect(result!.identity).toEqual(metaWithExtras.identity);
    expect(result!.runtimeOptions).toEqual(metaWithExtras.runtimeOptions);
  });

  describe("terminal uniqueness constraint", () => {
    it("should enforce that error state has lastErrorDetails", () => {
      const result = applySessionError(baseMeta, "Test error");

      // Terminal uniqueness: when state is "error", lastErrorDetails MUST be set
      expect(result!.state).toBe("error");
      expect(result!.lastErrorDetails).toBeDefined();
      expect(result!.lastErrorDetails!.message).toBe("Test error");
    });

    it("should include error category in details when provided", () => {
      const error: SessionAcpError = {
        message: "Policy violation",
        category: "policy",
        code: "POLICY_DENIED",
        timestamp: Date.now(),
      };
      const result = applySessionError(baseMeta, error);

      expect(result!.lastErrorDetails!.category).toBe("policy");
      expect(result!.lastErrorDetails!.code).toBe("POLICY_DENIED");
    });
  });
});

describe("clearSessionError", () => {
  const erroredMeta: SessionAcpMeta = {
    backend: "test-backend",
    agent: "test-agent",
    runtimeSessionName: "test-session",
    mode: "persistent",
    state: "error",
    lastActivityAt: Date.now(),
    lastErrorDetails: {
      message: "Previous error",
      category: "runtime",
      timestamp: Date.now(),
    },
  };

  it("should return null when current is undefined", () => {
    const result = clearSessionError(undefined);
    expect(result).toBeNull();
  });

  it("should transition from error to idle state", () => {
    const result = clearSessionError(erroredMeta);

    expect(result).not.toBeNull();
    expect(result!.state).toBe("idle");
  });

  it("should clear lastErrorDetails", () => {
    const result = clearSessionError(erroredMeta);

    expect(result!.lastErrorDetails).toBeUndefined();
  });

  it("should preserve non-error fields", () => {
    const result = clearSessionError(erroredMeta);

    expect(result!.backend).toBe("test-backend");
    expect(result!.agent).toBe("test-agent");
    expect(result!.mode).toBe("persistent");
  });
});

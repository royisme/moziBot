import { describe, it, expect } from "vitest";
import {
  extractShellWrapperCommand,
  hasEnvManipulationBeforeShellWrapper,
  resolveDispatchWrapperExecutionPlan,
  isShellWrapperExecutable,
  isDispatchWrapperExecutable,
} from "./exec-wrapper-resolution.js";

describe("exec-wrapper-resolution", () => {
  describe("extractShellWrapperCommand", () => {
    it("detects bash -c as shell wrapper", () => {
      const result = extractShellWrapperCommand(["bash", "-c", "echo hi"]);
      expect(result.isWrapper).toBe(true);
      expect(result.command).toBe("echo hi");
    });

    it("detects bash -lc as shell wrapper", () => {
      const result = extractShellWrapperCommand(["bash", "-lc", "echo hi && whoami"]);
      expect(result.isWrapper).toBe(true);
      expect(result.command).toBe("echo hi && whoami");
    });

    it("detects sh -c as shell wrapper", () => {
      const result = extractShellWrapperCommand(["/bin/sh", "-c", "ls -la"]);
      expect(result.isWrapper).toBe(true);
      expect(result.command).toBe("ls -la");
    });

    it("detects zsh -c as shell wrapper", () => {
      const result = extractShellWrapperCommand(["zsh", "-c", "echo test"]);
      expect(result.isWrapper).toBe(true);
      expect(result.command).toBe("echo test");
    });

    it("returns false for direct command", () => {
      const result = extractShellWrapperCommand(["echo", "hello"]);
      expect(result.isWrapper).toBe(false);
      expect(result.command).toBeNull();
    });

    it("returns false for git command", () => {
      const result = extractShellWrapperCommand(["git", "status"]);
      expect(result.isWrapper).toBe(false);
      expect(result.command).toBeNull();
    });

    it("handles env wrapper transparently", () => {
      const result = extractShellWrapperCommand(["env", "bash", "-lc", "echo hi"]);
      expect(result.isWrapper).toBe(true);
      expect(result.command).toBe("echo hi");
    });

    it("returns false for empty argv", () => {
      const result = extractShellWrapperCommand([]);
      expect(result.isWrapper).toBe(false);
      expect(result.command).toBeNull();
    });
  });

  describe("hasEnvManipulationBeforeShellWrapper", () => {
    it("returns true when env has variable assignments before shell", () => {
      expect(hasEnvManipulationBeforeShellWrapper(["env", "FOO=bar", "bash", "-lc", "cmd"])).toBe(true);
    });

    it("returns false when env is transparent (no modifiers)", () => {
      expect(hasEnvManipulationBeforeShellWrapper(["env", "bash", "-lc", "cmd"])).toBe(false);
    });

    it("returns false for non-env commands", () => {
      expect(hasEnvManipulationBeforeShellWrapper(["bash", "-lc", "cmd"])).toBe(false);
    });

    it("returns false for direct commands", () => {
      expect(hasEnvManipulationBeforeShellWrapper(["echo", "hello"])).toBe(false);
    });
  });

  describe("isShellWrapperExecutable / isDispatchWrapperExecutable", () => {
    it("identifies bash as shell wrapper", () => {
      expect(isShellWrapperExecutable("bash")).toBe(true);
    });

    it("identifies sh as shell wrapper", () => {
      expect(isShellWrapperExecutable("sh")).toBe(true);
    });

    it("identifies env as dispatch wrapper", () => {
      expect(isDispatchWrapperExecutable("env")).toBe(true);
    });

    it("does not identify echo as shell wrapper", () => {
      expect(isShellWrapperExecutable("echo")).toBe(false);
    });
  });

  describe("resolveDispatchWrapperExecutionPlan", () => {
    it("unwraps env to inner command", () => {
      const plan = resolveDispatchWrapperExecutionPlan(["env", "echo", "hi"]);
      expect(plan.policyBlocked).toBe(false);
      expect(plan.argv).toEqual(["echo", "hi"]);
    });

    it("blocks sudo wrapper", () => {
      const plan = resolveDispatchWrapperExecutionPlan(["sudo", "rm", "-rf", "/"]);
      expect(plan.policyBlocked).toBe(true);
    });
  });
});

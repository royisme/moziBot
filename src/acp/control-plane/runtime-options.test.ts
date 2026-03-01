import { describe, expect, it } from "vitest";
import type { SessionAcpMeta } from "../types";
import {
  validateRuntimeModeInput,
  validateRuntimeModelInput,
  validateRuntimePermissionProfileInput,
  validateRuntimeCwdInput,
  validateRuntimeTimeoutSecondsInput,
  parseRuntimeTimeoutSecondsInput,
  validateRuntimeConfigOptionInput,
  validateRuntimeOptionPatch,
  normalizeText,
  normalizeRuntimeOptions,
  mergeRuntimeOptions,
  resolveRuntimeOptionsFromMeta,
  runtimeOptionsEqual,
  buildRuntimeControlSignature,
  buildRuntimeConfigOptionPairs,
  inferRuntimeOptionPatchFromConfigOption,
} from "./runtime-options";

describe("runtime-options", () => {
  describe("normalizeText", () => {
    it("should return trimmed string", () => {
      expect(normalizeText("  hello  ")).toBe("hello");
    });

    it("should return undefined for empty string", () => {
      expect(normalizeText("")).toBeUndefined();
      expect(normalizeText("   ")).toBeUndefined();
    });

    it("should return undefined for non-string", () => {
      expect(normalizeText(123)).toBeUndefined();
      expect(normalizeText(null)).toBeUndefined();
      expect(normalizeText(undefined)).toBeUndefined();
    });
  });

  describe("validateRuntimeModeInput", () => {
    it("should accept valid mode", () => {
      expect(validateRuntimeModeInput("plan")).toBe("plan");
      expect(validateRuntimeModeInput("normal")).toBe("normal");
    });

    it("should reject empty mode", () => {
      expect(() => validateRuntimeModeInput("")).toThrow("must not be empty");
    });

    it("should reject too long mode", () => {
      expect(() => validateRuntimeModeInput("a".repeat(100))).toThrow("at most");
    });
  });

  describe("validateRuntimeModelInput", () => {
    it("should accept valid model", () => {
      expect(validateRuntimeModelInput("gpt-4")).toBe("gpt-4");
    });

    it("should reject empty model", () => {
      expect(() => validateRuntimeModelInput("")).toThrow("must not be empty");
    });
  });

  describe("validateRuntimePermissionProfileInput", () => {
    it("should accept valid profile", () => {
      expect(validateRuntimePermissionProfileInput("default")).toBe("default");
    });

    it("should reject empty profile", () => {
      expect(() => validateRuntimePermissionProfileInput("")).toThrow("must not be empty");
    });
  });

  describe("validateRuntimeCwdInput", () => {
    it("should accept absolute path", () => {
      expect(validateRuntimeCwdInput("/home/user")).toBe("/home/user");
    });

    it("should reject relative path", () => {
      expect(() => validateRuntimeCwdInput("./relative")).toThrow("absolute path");
    });

    it("should reject empty path", () => {
      expect(() => validateRuntimeCwdInput("")).toThrow("must not be empty");
    });
  });

  describe("validateRuntimeTimeoutSecondsInput", () => {
    it("should accept valid timeout", () => {
      expect(validateRuntimeTimeoutSecondsInput(60)).toBe(60);
      expect(validateRuntimeTimeoutSecondsInput(1)).toBe(1);
    });

    it("should reject non-number", () => {
      expect(() => validateRuntimeTimeoutSecondsInput("60" as unknown as number)).toThrow(
        "positive integer",
      );
    });

    it("should reject too small timeout", () => {
      expect(() => validateRuntimeTimeoutSecondsInput(0)).toThrow("between");
    });

    it("should reject too large timeout", () => {
      expect(() => validateRuntimeTimeoutSecondsInput(24 * 60 * 60 + 1)).toThrow("between");
    });
  });

  describe("parseRuntimeTimeoutSecondsInput", () => {
    it("should parse string number", () => {
      expect(parseRuntimeTimeoutSecondsInput("60")).toBe(60);
    });

    it("should reject non-numeric string", () => {
      expect(() => parseRuntimeTimeoutSecondsInput("abc")).toThrow("positive integer");
    });

    it("should reject empty string", () => {
      expect(() => parseRuntimeTimeoutSecondsInput("")).toThrow("positive integer");
    });
  });

  describe("validateRuntimeConfigOptionInput", () => {
    it("should validate key-value pair", () => {
      const result = validateRuntimeConfigOptionInput("model", "gpt-4");
      expect(result.key).toBe("model");
      expect(result.value).toBe("gpt-4");
    });

    it("should accept key with dots and dashes", () => {
      const result = validateRuntimeConfigOptionInput("approval.policy", "strict");
      expect(result.key).toBe("approval.policy");
    });

    it("should reject invalid key characters", () => {
      expect(() => validateRuntimeConfigOptionInput("model!", "gpt-4")).toThrow(
        "letters, numbers, dots, colons, underscores, or dashes",
      );
    });
  });

  describe("validateRuntimeOptionPatch", () => {
    it("should return empty object for undefined", () => {
      expect(validateRuntimeOptionPatch(undefined)).toEqual({});
    });

    it("should validate valid patch", () => {
      const result = validateRuntimeOptionPatch({
        model: "gpt-4o",
        runtimeMode: "plan",
      });
      expect(result.model).toBe("gpt-4o");
      expect(result.runtimeMode).toBe("plan");
    });

    it("should reject unknown keys", () => {
      expect(() =>
        validateRuntimeOptionPatch({
          unknownKey: "value",
        } as unknown as Record<string, string>),
      ).toThrow("Unknown runtime option");
    });

    it("should normalize values", () => {
      const result = validateRuntimeOptionPatch({
        model: "  gpt-4  ",
      });
      expect(result.model).toBe("gpt-4");
    });
  });

  describe("normalizeRuntimeOptions", () => {
    it("should normalize all options", () => {
      const options = {
        runtimeMode: "  plan  ",
        model: "gpt-4",
        cwd: "/home/user",
        permissionProfile: "default",
        timeoutSeconds: 60,
        backendExtras: { key1: "value1" },
      };
      const normalized = normalizeRuntimeOptions(options);
      expect(normalized.runtimeMode).toBe("plan");
      expect(normalized.model).toBe("gpt-4");
      expect(normalized.cwd).toBe("/home/user");
      expect(normalized.permissionProfile).toBe("default");
      expect(normalized.timeoutSeconds).toBe(60);
      expect(normalized.backendExtras?.key1).toBe("value1");
    });

    it("should remove undefined values", () => {
      const options = {
        model: undefined,
        runtimeMode: "plan",
      };
      const normalized = normalizeRuntimeOptions(options as unknown as Record<string, string>);
      expect(normalized.model).toBeUndefined();
      expect(normalized.runtimeMode).toBe("plan");
    });

    it("should return empty object for undefined input", () => {
      expect(normalizeRuntimeOptions(undefined)).toEqual({});
    });
  });

  describe("mergeRuntimeOptions", () => {
    it("should merge current and patch", () => {
      const result = mergeRuntimeOptions({
        current: { model: "gpt-4" },
        patch: { runtimeMode: "plan" },
      });
      expect(result.model).toBe("gpt-4");
      expect(result.runtimeMode).toBe("plan");
    });

    it("should allow patch to override current", () => {
      const result = mergeRuntimeOptions({
        current: { model: "gpt-4" },
        patch: { model: "gpt-4o" },
      });
      expect(result.model).toBe("gpt-4o");
    });

    it("should merge backendExtras", () => {
      const result = mergeRuntimeOptions({
        current: { backendExtras: { a: "1" } },
        patch: { backendExtras: { b: "2" } },
      });
      expect(result.backendExtras).toEqual({ a: "1", b: "2" });
    });
  });

  describe("resolveRuntimeOptionsFromMeta", () => {
    it("should resolve options from meta", () => {
      const meta: SessionAcpMeta = {
        backend: "test",
        agent: "main",
        runtimeSessionName: "test",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
        cwd: "/home/user",
        runtimeOptions: { model: "gpt-4" },
      };
      const options = resolveRuntimeOptionsFromMeta(meta);
      expect(options.model).toBe("gpt-4");
      expect(options.cwd).toBe("/home/user");
    });

    it("should use meta.cwd when runtimeOptions.cwd is not set", () => {
      const meta: SessionAcpMeta = {
        backend: "test",
        agent: "main",
        runtimeSessionName: "test",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
        cwd: "/home/user",
      };
      const options = resolveRuntimeOptionsFromMeta(meta);
      expect(options.cwd).toBe("/home/user");
    });
  });

  describe("runtimeOptionsEqual", () => {
    it("should compare equal options", () => {
      expect(runtimeOptionsEqual({ model: "gpt-4" }, { model: "gpt-4" })).toBe(true);
    });

    it("should compare different options", () => {
      expect(runtimeOptionsEqual({ model: "gpt-4" }, { model: "gpt-4o" })).toBe(false);
    });

    it("should handle undefined", () => {
      expect(runtimeOptionsEqual(undefined, undefined)).toBe(true);
      expect(runtimeOptionsEqual({ model: "gpt-4" }, undefined)).toBe(false);
    });
  });

  describe("buildRuntimeControlSignature", () => {
    it("should build consistent signature", () => {
      const options = { model: "gpt-4", runtimeMode: "plan" };
      const sig1 = buildRuntimeControlSignature(options);
      const sig2 = buildRuntimeControlSignature(options);
      expect(sig1).toBe(sig2);
    });

    it("should produce different signatures for different options", () => {
      const sig1 = buildRuntimeControlSignature({ model: "gpt-4" });
      const sig2 = buildRuntimeControlSignature({ model: "gpt-4o" });
      expect(sig1).not.toBe(sig2);
    });
  });

  describe("buildRuntimeConfigOptionPairs", () => {
    it("should build config pairs", () => {
      const options = {
        model: "gpt-4",
        permissionProfile: "default",
        timeoutSeconds: 60,
      };
      const pairs = buildRuntimeConfigOptionPairs(options);
      expect(pairs).toContainEqual(["model", "gpt-4"]);
      expect(pairs).toContainEqual(["approval_policy", "default"]);
      expect(pairs).toContainEqual(["timeout", "60"]);
    });
  });

  describe("inferRuntimeOptionPatchFromConfigOption", () => {
    it("should infer model", () => {
      const patch = inferRuntimeOptionPatchFromConfigOption("model", "gpt-4");
      expect(patch.model).toBe("gpt-4");
    });

    it("should infer approval_policy", () => {
      const patch = inferRuntimeOptionPatchFromConfigOption("approval_policy", "default");
      expect(patch.permissionProfile).toBe("default");
    });

    it("should infer timeout", () => {
      const patch = inferRuntimeOptionPatchFromConfigOption("timeout", "120");
      expect(patch.timeoutSeconds).toBe(120);
    });

    it("should infer cwd", () => {
      const patch = inferRuntimeOptionPatchFromConfigOption("cwd", "/home/user");
      expect(patch.cwd).toBe("/home/user");
    });

    it("should infer backendExtras for unknown keys", () => {
      const patch = inferRuntimeOptionPatchFromConfigOption("custom_key", "value");
      expect(patch.backendExtras).toEqual({ custom_key: "value" });
    });
  });
});

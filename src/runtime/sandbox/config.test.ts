import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  SandboxBoundary,
  resolveCwd,
  buildSafeEnv,
  validateCommand,
  extractCommandNames,
  splitCommandSegments,
  extractFirstCommandName,
  createSandboxBoundary,
  BLOCKED_ENV_KEYS,
} from "./config.js";

describe("SandboxBoundary", () => {
  describe("resolveCwd", () => {
    let tempDir: string;
    let boundary: SandboxBoundary;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-sandbox-test-"));
      boundary = {
        workspaceDir: tempDir,
        mode: "off",
      };
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should use workspace dir when cwd is not provided", () => {
      const result = resolveCwd(boundary);
      expect(result).toBe(tempDir);
    });

    it("should resolve absolute cwd within workspace", () => {
      const subdir = path.join(tempDir, "subdir");
      fs.mkdirSync(subdir);
      const result = resolveCwd(boundary, subdir);
      expect(result).toBe(subdir);
    });

    it("should resolve relative cwd within workspace", () => {
      const subdir = path.join(tempDir, "subdir");
      fs.mkdirSync(subdir);
      const result = resolveCwd(boundary, "subdir");
      expect(result).toBe(subdir);
    });

    it("should throw when cwd is outside workspace", () => {
      const parentDir = path.dirname(tempDir);
      expect(() => resolveCwd(boundary, parentDir)).toThrow("cwd must be within workspace");
    });

    it("should throw when cwd is absolute path outside workspace", () => {
      const otherDir = os.tmpdir();
      expect(() => resolveCwd(boundary, otherDir)).toThrow("cwd must be within workspace");
    });

    it("should handle cwd with .. attempts outside workspace", () => {
      const subdir = path.join(tempDir, "subdir");
      fs.mkdirSync(subdir);
      expect(() => resolveCwd(boundary, "../parent")).toThrow("cwd must be within workspace");
    });
  });

  describe("buildSafeEnv", () => {
    let boundary: SandboxBoundary;

    beforeEach(() => {
      boundary = {
        workspaceDir: "/tmp",
        mode: "off",
        blockedEnvKeys: Array.from(BLOCKED_ENV_KEYS),
      };
    });

    it("should return current process env when no override", () => {
      const result = buildSafeEnv(boundary);
      expect(result).toHaveProperty("PATH");
      expect(result).toHaveProperty("HOME");
    });

    it("should add override env variables", () => {
      const result = buildSafeEnv(boundary, { MY_VAR: "test" });
      expect(result.MY_VAR).toBe("test");
    });

    it("should throw when override contains blocked env key", () => {
      expect(() => buildSafeEnv(boundary, { PATH: "/usr/bin" })).toThrow("env PATH is not allowed");
    });

    it("should throw when override contains blocked env key (case insensitive)", () => {
      expect(() => buildSafeEnv(boundary, { path: "/usr/bin" })).toThrow("env path is not allowed");
    });

    it("should allow custom blocked env keys", () => {
      const customBoundary: SandboxBoundary = {
        workspaceDir: "/tmp",
        mode: "off",
        blockedEnvKeys: ["CUSTOM_KEY"],
      };
      expect(() => buildSafeEnv(customBoundary, { CUSTOM_KEY: "value" })).toThrow("env CUSTOM_KEY is not allowed");
    });

    it("should block uppercase overrides when blockedEnvKeys entries are lowercase", () => {
      const customBoundary: SandboxBoundary = {
        workspaceDir: "/tmp",
        mode: "off",
        blockedEnvKeys: ["path"],
      };
      expect(() => buildSafeEnv(customBoundary, { PATH: "/usr/bin" })).toThrow("env PATH is not allowed");
    });

    it("should not block keys not in blockedEnvKeys", () => {
      const customBoundary: SandboxBoundary = {
        workspaceDir: "/tmp",
        mode: "off",
        blockedEnvKeys: ["ONLY_THIS"],
      };
      const result = buildSafeEnv(customBoundary, { OTHER_KEY: "value" });
      expect(result.OTHER_KEY).toBe("value");
    });
  });

  describe("validateCommand", () => {

    it("should allow command when no allowlist", () => {
      const result = validateCommand("ls -la", undefined);
      expect(result.ok).toBe(true);
    });

    it("should allow command when allowlist is empty", () => {
      const result = validateCommand("ls -la", []);
      expect(result.ok).toBe(true);
    });

    it("should allow allowed commands", () => {
      const result = validateCommand("git status", ["git", "npm"]);
      expect(result.ok).toBe(true);
    });

    it("should allow allowed commands with multiple segments", () => {
      const result = validateCommand("npm install && git status", ["git", "npm"]);
      expect(result.ok).toBe(true);
    });

    it("should reject disallowed commands", () => {
      const result = validateCommand("ls -la", ["git", "npm"]);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain("not allowed");
    });

    it("should reject when command cannot be resolved", () => {
      const result = validateCommand("", ["git", "npm"]);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe("unable to resolve command");
    });

    it("should reject if any command in chain is disallowed", () => {
      const result = validateCommand("git status && rm -rf /", ["git", "npm"]);
      expect(result.ok).toBe(false);
    });
  });

  describe("extractCommandNames", () => {
    it("should extract single command", () => {
      expect(extractCommandNames("ls -la")).toContain("ls");
    });

    it("should extract commands with pipes", () => {
      const names = extractCommandNames("cat file.txt | grep test");
      expect(names).toContain("cat");
      expect(names).toContain("grep");
    });

    it("should extract commands with semicolons", () => {
      const names = extractCommandNames("echo hi; ls -la");
      expect(names).toContain("echo");
      expect(names).toContain("ls");
    });

    it("should extract commands with &&", () => {
      const names = extractCommandNames("npm install && node index.js");
      expect(names).toContain("npm");
      expect(names).toContain("node");
    });

    it("should extract commands with ||", () => {
      const names = extractCommandNames("git status || echo failed");
      expect(names).toContain("git");
      expect(names).toContain("echo");
    });

    it("should handle quoted commands", () => {
      const names = extractCommandNames('./script.sh "arg with spaces"');
      expect(names).toContain("script.sh");
    });

    it("should skip environment variable assignments", () => {
      const names = extractCommandNames("PATH=/usr/bin ls");
      expect(names).toContain("ls");
    });
  });

  describe("splitCommandSegments", () => {
    it("should split on semicolon", () => {
      const segments = splitCommandSegments("cmd1; cmd2");
      expect(segments).toHaveLength(2);
    });

    it("should split on &&", () => {
      const segments = splitCommandSegments("cmd1 && cmd2");
      expect(segments).toHaveLength(2);
    });

    it("should split on ||", () => {
      const segments = splitCommandSegments("cmd1 || cmd2");
      expect(segments).toHaveLength(2);
    });

    it("should split on pipe", () => {
      const segments = splitCommandSegments("cmd1 | cmd2");
      expect(segments).toHaveLength(2);
    });

    it("should preserve quoted semicolons", () => {
      const segments = splitCommandSegments('echo "a; b"');
      expect(segments).toHaveLength(1);
    });

    it("should handle empty segments", () => {
      const segments = splitCommandSegments("cmd1;; cmd2");
      expect(segments).toHaveLength(2);
    });
  });

  describe("extractFirstCommandName", () => {
    it("should extract simple command", () => {
      expect(extractFirstCommandName("ls -la")).toBe("ls");
    });

    it("should extract command with path", () => {
      expect(extractFirstCommandName("/usr/bin/node index.js")).toBe("node");
    });

    it("should extract quoted command", () => {
      expect(extractFirstCommandName('"./script.sh" arg')).toBe("script.sh");
    });

    it("should skip env var assignments", () => {
      expect(extractFirstCommandName("FOO=bar ls")).toBe("ls");
    });

    it("should return null for empty string", () => {
      expect(extractFirstCommandName("")).toBeNull();
    });

    it("should return null for whitespace only", () => {
      expect(extractFirstCommandName("   ")).toBeNull();
    });
  });

  describe("createSandboxBoundary", () => {
    it("should create boundary with given workspaceDir", () => {
      const boundary = createSandboxBoundary("/my/workspace");
      expect(boundary.workspaceDir).toBe("/my/workspace");
      expect(boundary.mode).toBe("off");
      expect(boundary.blockedEnvKeys).toBeDefined();
    });

    it("should use allowlist from parameter", () => {
      const boundary = createSandboxBoundary("/my/workspace", undefined, ["git", "npm"]);
      expect(boundary.allowlist).toEqual(["git", "npm"]);
    });

    it("should use mode from config", () => {
      const boundary = createSandboxBoundary("/my/workspace", { mode: "docker" });
      expect(boundary.mode).toBe("docker");
    });

    it("should set mode to vibebox when apple backend is vibebox", () => {
      const boundary = createSandboxBoundary("/my/workspace", {
        mode: "apple-vm",
        apple: { backend: "vibebox" },
      });
      expect(boundary.mode).toBe("vibebox");
    });

    it("should set mode to vibebox when vibebox.enabled is true", () => {
      const boundary = createSandboxBoundary("/my/workspace", {
        mode: "apple-vm",
        apple: { vibebox: { enabled: true } },
      });
      expect(boundary.mode).toBe("vibebox");
    });

    it("should not set vibebox mode when apple backend is native", () => {
      const boundary = createSandboxBoundary("/my/workspace", {
        mode: "apple-vm",
        apple: { backend: "native" },
      });
      expect(boundary.mode).toBe("apple-vm");
    });

    it("should not set vibebox mode when vibebox.enabled is false", () => {
      const boundary = createSandboxBoundary("/my/workspace", {
        mode: "apple-vm",
        apple: { vibebox: { enabled: false } },
      });
      expect(boundary.mode).toBe("apple-vm");
    });
  });
});

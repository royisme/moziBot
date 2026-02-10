import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { MoziConfig } from "../config";
import { isInsideWorkspace, isWithinRoot } from "./qmd/path-utils";
import {
  deriveChannelFromKey,
  deriveChatTypeFromKey,
  isScopeAllowed,
  normalizeSessionKey,
} from "./qmd/scope";
import { clampResultsByInjectedChars, extractSnippetLines } from "./qmd/snippet";
import { resolveMemoryBackendConfig } from "./backend-config";

describe("QmdMemoryManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-qmd-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("scope matching", () => {
    test("denies by default if scope.default is deny and no rule matches", () => {
      const scope = {
        default: "deny" as const,
        rules: [],
      };
      const allowed = isScopeAllowed(scope, "agent:main:telegram:dm:user1");
      expect(allowed).toBe(false);
    });

    test("allows direct chat when rule matches chatType direct", () => {
      const scope = {
        default: "deny" as const,
        rules: [
          {
            action: "allow" as const,
            match: { chatType: "direct" as const },
          },
        ],
      };
      const allowed = isScopeAllowed(scope, "agent:main:telegram:dm:user1");
      expect(allowed).toBe(true);
    });

    test("denies group chat when only direct is allowed", () => {
      const scope = {
        default: "deny" as const,
        rules: [
          {
            action: "allow" as const,
            match: { chatType: "direct" as const },
          },
        ],
      };
      const allowed = isScopeAllowed(scope, "agent:main:telegram:group:room1");
      expect(allowed).toBe(false);
    });

    test("allows by channel match", () => {
      const scope = {
        default: "deny" as const,
        rules: [
          {
            action: "allow" as const,
            match: { channel: "telegram" },
          },
        ],
      };
      const allowed = isScopeAllowed(scope, "agent:main:telegram:dm:user1");
      expect(allowed).toBe(true);
    });

    test("denies by channel mismatch", () => {
      const scope = {
        default: "deny" as const,
        rules: [
          {
            action: "allow" as const,
            match: { channel: "discord" },
          },
        ],
      };
      const allowed = isScopeAllowed(scope, "agent:main:telegram:dm:user1");
      expect(allowed).toBe(false);
    });

    test("allows by keyPrefix match", () => {
      const scope = {
        default: "deny" as const,
        rules: [
          {
            action: "allow" as const,
            match: { keyPrefix: "agent:main:telegram" },
          },
        ],
      };
      const allowed = isScopeAllowed(scope, "agent:main:telegram:dm:user1");
      expect(allowed).toBe(true);
    });

    test("denies subagent sessions", () => {
      const scope = {
        default: "allow" as const,
        rules: [],
      };
      const allowed = isScopeAllowed(scope, "agent:main:subagent:task123");
      expect(allowed).toBe(true);
    });
  });

  describe("scope helpers", () => {
    test("derive channel and chat type", () => {
      expect(deriveChannelFromKey("agent:main:telegram:dm:user1")).toBe("telegram");
      expect(deriveChatTypeFromKey("agent:main:telegram:group:room1")).toBe("group");
      expect(normalizeSessionKey("agent:main:subagent:task")).toBeUndefined();
    });
  });

  describe("path safety", () => {
    test("isWithinRoot rejects path traversal", () => {
      const root = "/home/user/workspace";
      expect(isWithinRoot(root, "/home/user/workspace/file.md")).toBe(true);
      expect(isWithinRoot(root, "/home/user/workspace")).toBe(true);
      expect(isWithinRoot(root, "/home/user/other")).toBe(false);
      expect(isWithinRoot(root, "/etc/passwd")).toBe(false);
    });

    test("isInsideWorkspace detects parent traversal", () => {
      expect(isInsideWorkspace("")).toBe(true);
      expect(isInsideWorkspace("file.md")).toBe(true);
      expect(isInsideWorkspace("dir/file.md")).toBe(true);
      expect(isInsideWorkspace("../other")).toBe(false);
      expect(isInsideWorkspace("/absolute/path")).toBe(false);
    });
  });

  describe("clampResultsByInjectedChars", () => {
    test("clamps snippets within budget", () => {
      const results = [
        {
          path: "a.md",
          startLine: 1,
          endLine: 1,
          score: 1,
          snippet: "hello",
          source: "memory" as const,
        },
        {
          path: "b.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "world",
          source: "memory" as const,
        },
        {
          path: "c.md",
          startLine: 1,
          endLine: 1,
          score: 0.8,
          snippet: "extra",
          source: "memory" as const,
        },
      ];
      const clamped = clampResultsByInjectedChars(results, 12);
      expect(clamped.length).toBe(3);
      expect(clamped[0].snippet).toBe("hello");
      expect(clamped[1].snippet).toBe("world");
      expect(clamped[2].snippet).toBe("ex");
    });

    test("returns all results if budget is 0 or negative", () => {
      const results = [
        {
          path: "a.md",
          startLine: 1,
          endLine: 1,
          score: 1,
          snippet: "hello",
          source: "memory" as const,
        },
      ];
      const clamped = clampResultsByInjectedChars(results, 0);
      expect(clamped.length).toBe(1);
    });
  });

  describe("extractSnippetLines", () => {
    test("parses @@ header format", () => {
      const snippet = "@@ -10,5 @@\nsome content here";
      const lines = extractSnippetLines(snippet);
      expect(lines.startLine).toBe(10);
      expect(lines.endLine).toBe(14);
    });

    test("defaults to counting lines when no header", () => {
      const snippet = "line1\nline2\nline3";
      const lines = extractSnippetLines(snippet);
      expect(lines.startLine).toBe(1);
      expect(lines.endLine).toBe(3);
    });
  });

  describe("reliability config", () => {
    test("resolves qmd reliability defaults", () => {
      const cfg = {
        paths: { baseDir: tmpDir },
        models: { providers: {} },
        agents: {
          defaults: { model: "quotio/gemini-3-flash-preview" },
          mozi: { skills: [] },
        },
        channels: {},
        memory: {
          backend: "qmd",
          qmd: {},
        },
      } as const;

      const resolved = resolveMemoryBackendConfig({
        cfg: cfg as unknown as MoziConfig,
        agentId: "mozi",
      });
      expect(resolved.qmd?.reliability).toEqual({
        maxRetries: 2,
        retryBackoffMs: 500,
        circuitBreakerThreshold: 3,
        circuitOpenMs: 30000,
      });
    });
  });
});

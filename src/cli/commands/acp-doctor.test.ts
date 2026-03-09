import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

const CLI_PATH = "src/cli/index.ts";

const BASE_CONFIG = {
  models: {
    providers: {
      quotio: {
        api: "openai-responses",
        apiKey: "test-key",
        models: [{ id: "gemini-3-flash-preview" }],
      },
    },
  },
  agents: {
    defaults: { model: "quotio/gemini-3-flash-preview" },
    mozi: { main: true, sandbox: { mode: "off" } },
  },
};

function writeConfig(dir: string, config: unknown): string {
  const configPath = path.join(dir, "config.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return configPath;
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runDoctor(configPath: string, extraArgs: string[] = []) {
  return spawnSync("tsx", [CLI_PATH, "acp", "doctor", "-c", configPath, ...extraArgs], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
}

test("acp doctor warns when acp is disabled", () => {
  const dir = tmpDir("mozi-acp-doctor-disabled-");
  const configPath = writeConfig(dir, { ...BASE_CONFIG, acp: { enabled: false } });

  const result = runDoctor(configPath);
  // Disabled is warn only, so exit 0
  expect(result.status).toBe(0);
  expect(result.stderr.toString()).toContain("ACP is disabled");
});

test("acp doctor fails when acp.backend is missing and acp is enabled", () => {
  const dir = tmpDir("mozi-acp-doctor-no-backend-");
  const configPath = writeConfig(dir, {
    ...BASE_CONFIG,
    acp: { enabled: true, dispatch: { enabled: true } },
  });

  const result = runDoctor(configPath);
  expect(result.status).toBe(1);
  expect(result.stderr.toString()).toContain("acp.backend");
});

test("acp doctor fails when defaultAgent is not defined in agents", () => {
  const dir = tmpDir("mozi-acp-doctor-bad-default-");
  const configPath = writeConfig(dir, {
    ...BASE_CONFIG,
    acp: {
      enabled: true,
      backend: "acpx",
      dispatch: { enabled: true },
      defaultAgent: "ghost-agent",
    },
  });

  const result = runDoctor(configPath);
  expect(result.status).toBe(1);
  expect(result.stderr.toString()).toContain("ghost-agent");
  expect(result.stderr.toString()).toContain("not defined in agents config");
});

test("acp doctor fails when allowedAgents contains unknown agent", () => {
  const dir = tmpDir("mozi-acp-doctor-bad-allowed-");
  const configPath = writeConfig(dir, {
    ...BASE_CONFIG,
    acp: {
      enabled: true,
      backend: "acpx",
      dispatch: { enabled: true },
      defaultAgent: "mozi",
      allowedAgents: ["mozi", "nonexistent-agent"],
    },
  });

  const result = runDoctor(configPath);
  expect(result.status).toBe(1);
  expect(result.stderr.toString()).toContain("nonexistent-agent");
});

test("acp doctor passes for consistent acp config", () => {
  const dir = tmpDir("mozi-acp-doctor-ok-");
  const configPath = writeConfig(dir, {
    ...BASE_CONFIG,
    acp: {
      enabled: true,
      backend: "acpx",
      dispatch: { enabled: true },
      defaultAgent: "mozi",
      allowedAgents: ["mozi"],
      runtime: { installCommand: "npm install -g acpx" },
    },
  });

  const result = runDoctor(configPath);
  expect(result.status).toBe(0);
  expect(result.stdout.toString()).toContain("Config check passed");
});

test("acp doctor --json outputs valid JSON", () => {
  const dir = tmpDir("mozi-acp-doctor-json-");
  const configPath = writeConfig(dir, {
    ...BASE_CONFIG,
    acp: {
      enabled: true,
      backend: "acpx",
      dispatch: { enabled: true },
      defaultAgent: "mozi",
      allowedAgents: ["mozi"],
      runtime: { installCommand: "npm install -g acpx" },
    },
  });

  const result = runDoctor(configPath, ["--json"]);
  expect(result.status).toBe(0);

  const parsed = JSON.parse(result.stdout.toString()) as {
    passed: boolean;
    findings: unknown[];
    summary: { pass: number; warn: number; fail: number };
  };
  expect(parsed).toHaveProperty("passed");
  expect(parsed).toHaveProperty("findings");
  expect(parsed).toHaveProperty("summary");
  expect(parsed.summary).toHaveProperty("pass");
  expect(parsed.summary).toHaveProperty("warn");
  expect(parsed.summary).toHaveProperty("fail");
  expect(parsed.passed).toBe(true);
});

test("acp doctor --json fails with blocking issues and outputs valid JSON", () => {
  const dir = tmpDir("mozi-acp-doctor-json-fail-");
  const configPath = writeConfig(dir, {
    ...BASE_CONFIG,
    acp: { enabled: true },
  });

  const result = runDoctor(configPath, ["--json"]);
  expect(result.status).toBe(1);

  const parsed = JSON.parse(result.stdout.toString()) as {
    passed: boolean;
    summary: { fail: number };
  };
  expect(parsed.passed).toBe(false);
  expect(parsed.summary.fail).toBeGreaterThan(0);
});

test("acp doctor --verbose shows passed checks", () => {
  const dir = tmpDir("mozi-acp-doctor-verbose-");
  const configPath = writeConfig(dir, {
    ...BASE_CONFIG,
    acp: {
      enabled: true,
      backend: "acpx",
      dispatch: { enabled: true },
      defaultAgent: "mozi",
      allowedAgents: ["mozi"],
      runtime: { installCommand: "npm install -g acpx" },
    },
  });

  const result = runDoctor(configPath, ["--verbose"]);
  expect(result.status).toBe(0);
  expect(result.stdout.toString()).toContain("Passed checks");
});

test("acp doctor warns about missing installCommand", () => {
  const dir = tmpDir("mozi-acp-doctor-no-install-");
  const configPath = writeConfig(dir, {
    ...BASE_CONFIG,
    acp: {
      enabled: true,
      backend: "acpx",
      dispatch: { enabled: true },
      defaultAgent: "mozi",
    },
  });

  const result = runDoctor(configPath);
  // Missing installCommand is a warn, not fail
  expect(result.status).toBe(0);
  expect(result.stderr.toString()).toContain("installCommand");
});

test("acp doctor warns about deprecated dispatchEnabled field", () => {
  const dir = tmpDir("mozi-acp-doctor-legacy-dispatch-");
  const configPath = writeConfig(dir, {
    ...BASE_CONFIG,
    acp: {
      enabled: true,
      backend: "acpx",
      dispatchEnabled: true,
      defaultAgent: "mozi",
      runtime: { installCommand: "npm install -g acpx" },
    },
  });

  const result = runDoctor(configPath);
  // Legacy field is a warn, exit 0
  expect(result.status).toBe(0);
  expect(result.stderr.toString()).toContain("deprecated");
});

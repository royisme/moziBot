import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureHome } from "../../src/agents/home";
import { ensureWorkspace } from "../../src/agents/workspace";
import { type MoziConfig, loadConfig } from "../../src/config";

const TEST_RUNTIME_ROOT = path.resolve(process.cwd(), "tests", "runtime");

export type RuntimeTestHarness = {
  suiteId: string;
  agentId: string;
  rootDir: string;
  homeDir: string;
  workspaceDir: string;
  sessionsDir: string;
  logsDir: string;
  config: MoziConfig;
  baseConfigPath: string;
};

function normalizeSuiteId(input: string): string {
  const normalized = input.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized || "default-suite";
}

function resolveBaseConfigCandidates(customPath?: string): string[] {
  const candidates: string[] = [];
  if (customPath?.trim()) {
    candidates.push(path.resolve(customPath));
  }

  const envPath = process.env.MOZI_TEST_CONFIG;
  if (envPath?.trim()) {
    candidates.push(path.resolve(envPath));
  }

  candidates.push(path.join(os.homedir(), ".mozi", "config.jsonc"));
  candidates.push(path.resolve(process.cwd(), "release", "config.example.jsonc"));
  return Array.from(new Set(candidates));
}

function loadBaseConfig(customPath?: string): { config: MoziConfig; configPath: string } {
  const errors: string[] = [];
  for (const candidate of resolveBaseConfigCandidates(customPath)) {
    const result = loadConfig(candidate);
    if (result.success && result.config) {
      return { config: result.config, configPath: result.path };
    }
    errors.push(...(result.errors ?? [`Failed to load config: ${candidate}`]));
  }
  throw new Error(`Unable to load test base config. Errors: ${errors.join(" | ")}`);
}

function applyRuntimeOverrides(params: {
  baseConfig: MoziConfig;
  agentId: string;
  rootDir: string;
  homeDir: string;
  workspaceDir: string;
  sessionsDir: string;
  logsDir: string;
}): MoziConfig {
  const config = structuredClone(params.baseConfig);
  config.paths = {
    ...config.paths,
    baseDir: params.rootDir,
    sessions: params.sessionsDir,
    logs: params.logsDir,
    workspace: params.workspaceDir,
  };

  const agents = (config.agents ?? {}) as Record<string, unknown>;
  const existingEntry =
    typeof agents[params.agentId] === "object" && agents[params.agentId] !== null
      ? (agents[params.agentId] as Record<string, unknown>)
      : {};
  agents[params.agentId] = {
    ...existingEntry,
    main: true,
    home: params.homeDir,
    workspace: params.workspaceDir,
  };
  config.agents = agents as MoziConfig["agents"];
  return config;
}

export async function prepareRuntimeTestHarness(params: {
  suiteId: string;
  agentId?: string;
  baseConfigPath?: string;
  reset?: boolean;
  ensureBootstrapFiles?: boolean;
}): Promise<RuntimeTestHarness> {
  const suiteId = normalizeSuiteId(params.suiteId);
  const agentId = params.agentId?.trim() || "mozi";

  const rootDir = path.join(TEST_RUNTIME_ROOT, suiteId);
  const homeDir = path.join(rootDir, "home");
  const workspaceDir = path.join(rootDir, "workspace");
  const sessionsDir = path.join(rootDir, "sessions");
  const logsDir = path.join(rootDir, "logs");

  if (params.reset !== false) {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });

  const { config: baseConfig, configPath } = loadBaseConfig(params.baseConfigPath);
  const config = applyRuntimeOverrides({
    baseConfig,
    agentId,
    rootDir,
    homeDir,
    workspaceDir,
    sessionsDir,
    logsDir,
  });

  if (params.ensureBootstrapFiles !== false) {
    await ensureHome(homeDir);
    await ensureWorkspace(workspaceDir);
  }

  return {
    suiteId,
    agentId,
    rootDir,
    homeDir,
    workspaceDir,
    sessionsDir,
    logsDir,
    config,
    baseConfigPath: configPath,
  };
}

import { execa } from "execa";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MoziConfig } from "../../config";
import type { SandboxConfig, SandboxMode, SandboxVibeboxConfig } from "./types";

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type CommandRunner = (params: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}) => Promise<CommandResult>;

export type SandboxBootstrapIssue = {
  agentId: string;
  mode: SandboxMode;
  level: "error" | "warn";
  message: string;
  hints: string[];
};

export type SandboxBootstrapAction = {
  agentId: string;
  mode: SandboxMode;
  message: string;
};

export type SandboxBootstrapResult = {
  ok: boolean;
  attempted: number;
  actions: SandboxBootstrapAction[];
  issues: SandboxBootstrapIssue[];
};

export type SandboxBootstrapOptions = {
  fix?: boolean;
  onlyAutoEnabled?: boolean;
  runCommand?: CommandRunner;
  timeoutMs?: number;
};

type AgentEntry = {
  id: string;
  workspaceDir: string;
  sandboxConfig: SandboxConfig;
  useVibebox: boolean;
};

type VibeboxProbePayload = {
  ok?: boolean;
  error?: string;
  selected?: string;
  diagnostics?: Record<string, { available?: boolean; reason?: string; fixHints?: string[] }>;
};

const DEFAULT_TIMEOUT_MS = 60_000;

export async function bootstrapSandboxes(
  config: MoziConfig,
  options: SandboxBootstrapOptions = {},
): Promise<SandboxBootstrapResult> {
  const runCommand = options.runCommand ?? runExternalCommand;
  const fix = options.fix ?? true;
  const targets = listSandboxTargets(config, options.onlyAutoEnabled === true);
  const result: SandboxBootstrapResult = {
    ok: true,
    attempted: 0,
    actions: [],
    issues: [],
  };

  for (const target of targets) {
    result.attempted += 1;
    if (target.useVibebox) {
      await bootstrapVibeboxTarget({
        target,
        fix,
        runCommand,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        result,
      });
      continue;
    }
    if (target.sandboxConfig.mode === "docker") {
      await bootstrapDockerTarget({
        target,
        fix,
        runCommand,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        result,
      });
      continue;
    }
    if (target.sandboxConfig.mode === "apple-vm") {
      await bootstrapAppleNativeTarget({
        target,
        runCommand,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        result,
      });
    }
  }

  result.ok = !result.issues.some((issue) => issue.level === "error");
  return result;
}

function listSandboxTargets(config: MoziConfig, onlyAutoEnabled: boolean): AgentEntry[] {
  const entries = listAgentEntries(config);
  const targets: AgentEntry[] = [];
  const defaults = (config.agents?.defaults as { sandbox?: SandboxConfig } | undefined)?.sandbox;

  for (const entry of entries) {
    const sandboxConfig = resolveSandboxConfig(
      defaults,
      entry.entry.sandbox as SandboxConfig | undefined,
    );
    const mode = sandboxConfig?.mode ?? "off";
    const useVibebox = shouldUseVibebox(sandboxConfig);
    if (mode === "off" && !useVibebox) {
      continue;
    }

    const autoBootstrap = resolveAutoBootstrap(
      defaults,
      entry.entry.sandbox as SandboxConfig | undefined,
    );
    if (onlyAutoEnabled && !autoBootstrap) {
      continue;
    }

    targets.push({
      id: entry.id,
      workspaceDir: resolveWorkspaceDir(config, entry.id, entry.entry.workspace),
      sandboxConfig: sandboxConfig ?? { mode: "off" },
      useVibebox,
    });
  }
  return targets;
}

function listAgentEntries(
  config: MoziConfig,
): Array<{ id: string; entry: Record<string, unknown> }> {
  const agents = config.agents ?? {};
  return Object.entries(agents)
    .filter(([id]) => id !== "defaults")
    .map(([id, entry]) => ({ id, entry: (entry ?? {}) as Record<string, unknown> }));
}

function resolveSandboxConfig(
  defaults?: SandboxConfig,
  override?: SandboxConfig,
): SandboxConfig | undefined {
  if (!defaults && !override) {
    return undefined;
  }
  return {
    ...defaults,
    ...override,
    docker: { ...defaults?.docker, ...override?.docker },
    apple: { ...defaults?.apple, ...override?.apple },
  };
}

function resolveAutoBootstrap(defaults?: SandboxConfig, override?: SandboxConfig): boolean {
  const defaultValue = defaults?.autoBootstrapOnStart ?? false;
  if (override?.autoBootstrapOnStart !== undefined) {
    return override.autoBootstrapOnStart;
  }
  return defaultValue;
}

function resolveWorkspaceDir(config: MoziConfig, agentId: string, explicit?: unknown): string {
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit;
  }
  if (config.paths?.baseDir) {
    return path.join(config.paths.baseDir, "agents", agentId, "workspace");
  }
  const root = config.paths?.workspace || "./workspace";
  return path.join(root, agentId);
}

function shouldUseVibebox(config?: SandboxConfig): boolean {
  if (!config) {
    return false;
  }
  if (config.apple?.backend === "vibebox") {
    return true;
  }
  return config.apple?.vibebox?.enabled === true;
}

async function bootstrapDockerTarget(params: {
  target: AgentEntry;
  fix: boolean;
  runCommand: CommandRunner;
  timeoutMs: number;
  result: SandboxBootstrapResult;
}) {
  const mode: SandboxMode = "docker";
  const image = params.target.sandboxConfig.docker?.image;
  if (!image) {
    pushIssue(params.result, {
      agentId: params.target.id,
      mode,
      level: "error",
      message: "Docker sandbox image is missing.",
      hints: ["Set agents.<id>.sandbox.docker.image in config.jsonc."],
    });
    return;
  }

  const info = await params.runCommand({
    command: "docker",
    args: ["info"],
    timeoutMs: params.timeoutMs,
  });
  if (info.exitCode !== 0) {
    pushIssue(params.result, {
      agentId: params.target.id,
      mode,
      level: "error",
      message: "Docker daemon is unavailable.",
      hints: ["Start Docker daemon.", "Run `docker info` manually for diagnostics."],
    });
    return;
  }

  const inspect = await params.runCommand({
    command: "docker",
    args: ["image", "inspect", image],
    timeoutMs: params.timeoutMs,
  });
  if (inspect.exitCode === 0) {
    pushAction(params.result, {
      agentId: params.target.id,
      mode,
      message: `Docker image is ready: ${image}`,
    });
    return;
  }

  if (!params.fix) {
    pushIssue(params.result, {
      agentId: params.target.id,
      mode,
      level: "warn",
      message: `Docker image is missing: ${image}`,
      hints: ["Run `mozi sandbox bootstrap` to pull required images."],
    });
    return;
  }

  const pull = await params.runCommand({
    command: "docker",
    args: ["pull", image],
    timeoutMs: params.timeoutMs,
  });
  if (pull.exitCode !== 0) {
    pushIssue(params.result, {
      agentId: params.target.id,
      mode,
      level: "error",
      message: `Failed to pull docker image: ${image}`,
      hints: [pull.stderr || "Check network connectivity and Docker credentials."],
    });
    return;
  }
  pushAction(params.result, {
    agentId: params.target.id,
    mode,
    message: `Pulled docker image: ${image}`,
  });
}

async function bootstrapAppleNativeTarget(params: {
  target: AgentEntry;
  runCommand: CommandRunner;
  timeoutMs: number;
  result: SandboxBootstrapResult;
}) {
  const mode: SandboxMode = "apple-vm";
  const image = params.target.sandboxConfig.apple?.image;
  if (!image) {
    pushIssue(params.result, {
      agentId: params.target.id,
      mode,
      level: "error",
      message: "Apple VM sandbox image is missing.",
      hints: ["Set agents.<id>.sandbox.apple.image in config.jsonc."],
    });
    return;
  }

  const info = await params.runCommand({
    command: "container",
    args: ["info"],
    timeoutMs: params.timeoutMs,
  });
  if (info.exitCode !== 0) {
    pushIssue(params.result, {
      agentId: params.target.id,
      mode,
      level: "error",
      message: "Apple container runtime is unavailable.",
      hints: ["Ensure `container` CLI is installed and available in PATH."],
    });
    return;
  }
  pushAction(params.result, {
    agentId: params.target.id,
    mode,
    message: "Apple VM runtime is available.",
  });
}

async function bootstrapVibeboxTarget(params: {
  target: AgentEntry;
  fix: boolean;
  runCommand: CommandRunner;
  timeoutMs: number;
  result: SandboxBootstrapResult;
}) {
  const mode = params.target.sandboxConfig.mode ?? "off";
  const vibeboxCfg = params.target.sandboxConfig.apple?.vibebox;
  const provider = resolveVibeboxProvider(vibeboxCfg, mode);
  const binPath = vibeboxCfg?.binPath || "vibebox";
  const projectRoot = vibeboxCfg?.projectRoot || params.target.workspaceDir;

  const probeArgs = ["probe", "--json", "--provider", provider, "--project-root", projectRoot];
  const probe = await params.runCommand({
    command: binPath,
    args: probeArgs,
    timeoutMs: params.timeoutMs,
  });
  const payload = parseJson<VibeboxProbePayload>(probe.stdout);
  if (!payload) {
    pushIssue(params.result, {
      agentId: params.target.id,
      mode,
      level: "error",
      message: "Vibebox probe output is not valid JSON.",
      hints: [`Command: ${binPath} ${probeArgs.join(" ")}`, probe.stderr || "No stderr output."],
    });
    return;
  }

  const selected = payload.selected || provider;
  const selectedDiag = payload.diagnostics?.[selected];
  const fallbackDiag = payload.diagnostics?.[normalizeSelectedMode(selected)];
  const diag = selectedDiag || fallbackDiag;
  if (payload.ok === false || diag?.available === false) {
    pushIssue(params.result, {
      agentId: params.target.id,
      mode,
      level: "error",
      message: payload.error || diag?.reason || "Vibebox backend is unavailable.",
      hints: diag?.fixHints || [],
    });
    return;
  }

  pushAction(params.result, {
    agentId: params.target.id,
    mode,
    message: `Vibebox backend is ready (provider=${selected}).`,
  });

  if (!params.fix) {
    return;
  }

  const hasProjectConfig = await exists(path.join(projectRoot, ".vibebox", "config.yaml"));
  if (hasProjectConfig) {
    return;
  }

  const init = await params.runCommand({
    command: binPath,
    args: ["init", "--non-interactive", "--provider", provider, "--project-root", projectRoot],
    timeoutMs: params.timeoutMs,
  });

  if (init.exitCode === 0) {
    pushAction(params.result, {
      agentId: params.target.id,
      mode,
      message: `Initialized vibebox project config at ${projectRoot}/.vibebox/config.yaml`,
    });
    return;
  }

  pushIssue(params.result, {
    agentId: params.target.id,
    mode,
    level: "warn",
    message: "Vibebox project initialization was skipped or failed.",
    hints: [
      "Run vibebox init manually if your workflow requires pre-provisioned images.",
      init.stderr || "No stderr output.",
    ],
  });
}

function resolveVibeboxProvider(
  config: SandboxVibeboxConfig | undefined,
  mode: SandboxMode,
): "off" | "apple-vm" | "docker" | "auto" {
  if (config?.provider) {
    return config.provider;
  }
  if (mode === "off") {
    return "off";
  }
  if (mode === "docker") {
    return "docker";
  }
  return "apple-vm";
}

function normalizeSelectedMode(input: string): "off" | "docker" | "apple-vm" {
  if (input === "off") {
    return "off";
  }
  if (input === "docker") {
    return "docker";
  }
  return "apple-vm";
}

function parseJson<T>(raw: string): T | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function pushIssue(result: SandboxBootstrapResult, issue: SandboxBootstrapIssue) {
  result.issues.push(issue);
}

function pushAction(result: SandboxBootstrapResult, action: SandboxBootstrapAction) {
  result.actions.push(action);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function runExternalCommand(params: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<CommandResult> {
  try {
    const result = await execa(params.command, params.args, {
      cwd: params.cwd,
      env: {
        ...process.env,
        ...params.env,
      },
      timeout: params.timeoutMs,
      reject: false,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 1,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: message, exitCode: 1 };
  }
}

export function formatBootstrapSummary(result: SandboxBootstrapResult): string[] {
  const lines: string[] = [];
  lines.push(`Sandbox bootstrap attempted: ${result.attempted}`);
  for (const action of result.actions) {
    lines.push(`- [action] ${action.agentId}(${action.mode}): ${action.message}`);
  }
  for (const issue of result.issues) {
    lines.push(`- [${issue.level}] ${issue.agentId}(${issue.mode}): ${issue.message}`);
    for (const hint of issue.hints) {
      lines.push(`  hint: ${hint}`);
    }
  }
  return lines;
}

export function defaultVibeboxBinPath(): string {
  return path.join(os.homedir(), ".mozi", "bin", "vibebox");
}

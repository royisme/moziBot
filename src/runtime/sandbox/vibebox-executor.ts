import type { SandboxProbeResult } from "./executor";
import type { SandboxExecParams } from "./service";
import type { SandboxVibeboxConfig } from "./types";
import { execa } from "execa";

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

type VibeboxDiagnostics = {
  available?: boolean;
  reason?: string;
  fixHints?: string[];
};

type VibeboxBridgePayload = {
  ok?: boolean;
  error?: string;
  selected?: string;
  diagnostics?: Record<string, VibeboxDiagnostics>;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

const DEFAULT_TIMEOUT_SECONDS = 120;

export class VibeboxExecutor {
  private runCommand: CommandRunner;
  private binPath: string;
  private provider: "off" | "apple-vm" | "docker" | "auto";
  private timeoutSeconds: number;
  private projectRoot?: string;

  constructor(params: {
    config?: SandboxVibeboxConfig;
    runCommand?: CommandRunner;
    defaultProvider?: "off" | "apple-vm" | "docker";
  }) {
    this.runCommand = params.runCommand ?? runExternalCommand;
    this.binPath = params.config?.binPath || "vibebox";
    this.provider = params.config?.provider || params.defaultProvider || "apple-vm";
    this.timeoutSeconds = params.config?.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS;
    this.projectRoot = params.config?.projectRoot;
  }

  async exec(
    params: SandboxExecParams,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const projectRoot = this.projectRoot || params.workspaceDir;
    const args = [
      "exec",
      "--json",
      "--provider",
      this.provider,
      "--project-root",
      projectRoot,
      "--command",
      params.command,
    ];
    if (params.cwd) {
      args.push("--cwd", params.cwd);
    }
    args.push("--timeout-seconds", String(this.timeoutSeconds));

    for (const [key, value] of Object.entries(params.env || {})) {
      args.push("--env", `${key}=${value}`);
    }

    const result = await this.runCommand({
      command: this.binPath,
      args,
      timeoutMs: this.timeoutSeconds * 1000,
    });

    const payload = parseJson<VibeboxBridgePayload>(result.stdout);

    if (!payload) {
      throw new Error(
        buildBridgeError({
          stage: "exec",
          command: this.binPath,
          args,
          result,
        }),
      );
    }
    if (payload.ok === false) {
      throw new Error(
        buildBridgeProtocolError({
          stage: "exec",
          payload,
          command: this.binPath,
          args,
          result,
        }),
      );
    }

    return {
      stdout: typeof payload.stdout === "string" ? payload.stdout : "",
      stderr: typeof payload.stderr === "string" ? payload.stderr : "",
      exitCode: typeof payload.exitCode === "number" ? payload.exitCode : result.exitCode,
    };
  }

  async stop(_sessionKey: string, _agentId: string): Promise<void> {
    return;
  }

  async probe(): Promise<SandboxProbeResult> {
    const args = ["probe", "--json", "--provider", this.provider];
    if (this.projectRoot) {
      args.push("--project-root", this.projectRoot);
    }

    const result = await this.runCommand({
      command: this.binPath,
      args,
      timeoutMs: this.timeoutSeconds * 1000,
    });

    const payload = parseJson<VibeboxBridgePayload>(result.stdout);

    if (!payload) {
      return {
        ok: false,
        mode: toSandboxMode(this.provider),
        message: "Vibebox probe failed: unable to parse JSON response.",
        hints: [
          "Ensure vibebox supports `probe --json` command contract.",
          `Command: ${this.binPath} ${args.join(" ")}`,
          result.stderr || "No stderr output.",
        ],
      };
    }

    const selected = payload.selected;
    const mode = toSandboxMode(selected || this.provider);
    const selectedDiag = selected ? payload.diagnostics?.[selected] : undefined;
    const modeDiag = payload.diagnostics?.[mode];
    const effectiveDiag = selectedDiag || modeDiag;
    if (payload.ok === false) {
      return {
        ok: false,
        mode,
        message:
          payload.error || effectiveDiag?.reason || "Vibebox probe reported unavailable backend.",
        hints: effectiveDiag?.fixHints || [],
      };
    }
    if (!effectiveDiag) {
      return {
        ok: false,
        mode,
        message: "Vibebox probe response is missing backend diagnostics.",
        hints: [
          "Ensure vibebox probe returns diagnostics payload for selected backend.",
          `Selected backend: ${payload.selected ?? "unknown"}`,
        ],
      };
    }
    return {
      ok: effectiveDiag.available !== false,
      mode,
      message:
        effectiveDiag.available === false
          ? effectiveDiag.reason || "Vibebox backend is unavailable."
          : `Vibebox ${mode} backend is available.`,
      hints: effectiveDiag.fixHints || [],
    };
  }
}

function toSandboxMode(input: string): "off" | "docker" | "apple-vm" {
  if (input === "off") {
    return "off";
  }
  if (input === "docker") {
    return "docker";
  }
  return "apple-vm";
}

function parseJson<T>(input: string): T | null {
  const text = input.trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function buildBridgeError(params: {
  stage: "exec" | "probe";
  command: string;
  args: string[];
  result: CommandResult;
}): string {
  return [
    `Vibebox ${params.stage} bridge failed: command output is not valid JSON.`,
    `Command: ${params.command} ${params.args.join(" ")}`,
    `Exit code: ${params.result.exitCode}`,
    params.result.stderr ? `stderr:\n${params.result.stderr}` : "stderr:",
    params.result.stdout ? `stdout:\n${params.result.stdout}` : "stdout:",
  ].join("\n");
}

function buildBridgeProtocolError(params: {
  stage: "exec" | "probe";
  payload: VibeboxBridgePayload;
  command: string;
  args: string[];
  result: CommandResult;
}): string {
  const selected = params.payload.selected || "unknown";
  const diagnostics = params.payload.diagnostics?.[selected];
  const hints = diagnostics?.fixHints || [];
  return [
    `Vibebox ${params.stage} bridge reported failure.`,
    `Command: ${params.command} ${params.args.join(" ")}`,
    `Error: ${params.payload.error || diagnostics?.reason || "unknown bridge error"}`,
    `Selected: ${selected}`,
    `Exit code: ${params.result.exitCode}`,
    hints.length > 0 ? `Hints: ${hints.join("; ")}` : "Hints:",
    params.result.stderr ? `stderr:\n${params.result.stderr}` : "stderr:",
    params.result.stdout ? `stdout:\n${params.result.stdout}` : "stdout:",
  ].join("\n");
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

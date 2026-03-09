import { spawn, type SpawnOptions } from "node:child_process";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
} from "../types";

/**
 * ACPX Runtime Backend Adapter
 *
 * This implements the AcpRuntime contract for the acpx backend.
 * ACPX is a local ACP runtime that executes sessions directly.
 *
 * Implementation notes from t1:
 * - Session creation: acpx codex sessions new --name <name> returns UUID
 * - Running turns: acpx codex prompt <text> with session from handle
 * - First prompt may fail with "Resource not found" - warmup quirk
 * - Status: acpx codex status --session <name> returns session, agent, pid, status, uptime, lastPromptTime
 * - Cancel: acpx codex cancel
 * - Close: acpx codex sessions close <name>
 * - agentSessionId is NOT available - status 'agent' field is command string
 */

/**
 * Execute an acpx command and return output
 */
async function runAcpxCommand(
  args: string[],
  options?: SpawnOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn("acpx", args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });

    proc.on("error", (err) => {
      stderr += err.message;
      resolve({ stdout, stderr, exitCode: -1 });
    });
  });
}

export class AcpxRuntimeBackend implements AcpRuntime {
  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    // Generate a unique session identifier
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const runtimeSessionName = `acpx-${input.sessionKey}-${timestamp}-${randomSuffix}`;

    // Create session via acpx CLI
    const { stdout, stderr, exitCode } = await runAcpxCommand([
      "codex",
      "sessions",
      "new",
      "--name",
      runtimeSessionName,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `Failed to create ACPX session: ${stderr || stdout || `exit code ${exitCode}`}`,
      );
    }

    // Parse session UUID from output - appears as plain text after status lines
    const uuidMatch = stdout.match(
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/im,
    );
    const backendSessionId = uuidMatch ? uuidMatch[1] : undefined;

    // agentSessionId is NOT available from ACPX - leave undefined per t1 findings

    return {
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName,
      cwd: input.cwd,
      backendSessionId,
      // agentSessionId intentionally undefined - ACPX does not expose this
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncGenerator<AcpRuntimeEvent> {
    const runtimeSessionName = input.handle.runtimeSessionName;

    yield {
      type: "started",
      requestId: input.requestId,
      timestamp: Date.now(),
    };

    if (input.signal?.aborted) {
      yield {
        type: "error",
        message: "Turn aborted before starting",
        category: "cancelled",
        timestamp: Date.now(),
      };
      return;
    }

    try {
      const proc = spawn("acpx", ["codex", "prompt", input.text, "--session", runtimeSessionName], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let outputBuffer = "";
      let stderrBuffer = "";
      let cancelled = false;
      const decoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();

      const exitCodePromise = new Promise<number | null>((resolve, reject) => {
        proc.once("close", (code: number | null) => resolve(code));
        proc.once("error", reject);
      });

      proc.stdout?.on("data", (data: Buffer) => {
        outputBuffer += decoder.decode(data, { stream: true });
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderrBuffer += stderrDecoder.decode(data, { stream: true });
      });

      const abortHandler = () => {
        cancelled = true;
        proc.kill("SIGTERM");
      };

      input.signal?.addEventListener("abort", abortHandler);
      const exitCode = await exitCodePromise;
      input.signal?.removeEventListener("abort", abortHandler);

      for (const line of outputBuffer.split("\n")) {
        if (!line) {
          continue;
        }
        if (line.includes("[thinking]")) {
          yield {
            type: "status",
            text: "Thinking...",
            timestamp: Date.now(),
          };
          continue;
        }
        if (!line.startsWith("[") && !line.startsWith("!")) {
          yield {
            type: "text_delta",
            text: `${line}\n`,
            timestamp: Date.now(),
          };
        }
      }

      if (cancelled) {
        yield {
          type: "error",
          message: "Turn aborted during execution",
          category: "cancelled",
          timestamp: Date.now(),
        };
        return;
      }

      if (stderrBuffer.includes("[error]")) {
        if (stderrBuffer.includes("Resource not found")) {
          yield {
            type: "error",
            message: "ACPX warmup failed: Resource not found. This may succeed on retry.",
            code: "WARMUP_FAILURE",
            category: "runtime",
            retryable: true,
            timestamp: Date.now(),
          };
          return;
        }

        const errorMatch = stderrBuffer.match(/\[error\]\s*(.+)/);
        const errorMsg = errorMatch ? errorMatch[1] : stderrBuffer;
        yield {
          type: "error",
          message: `ACPX error: ${errorMsg}`,
          category: "runtime",
          timestamp: Date.now(),
        };
        return;
      }

      if (exitCode !== 0 && exitCode !== null) {
        yield {
          type: "error",
          message: `ACPX process exited with code ${exitCode}: ${stderrBuffer}`,
          category: "runtime",
          timestamp: Date.now(),
        };
        return;
      }

      let stopReason = "completed";
      if (outputBuffer.includes("[done] cancelled") || stderrBuffer.includes("[done] cancelled")) {
        stopReason = "cancelled";
      }

      yield {
        type: "done",
        stopReason,
        timestamp: Date.now(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield {
        type: "error",
        message: `ACPX execution failed: ${message}`,
        category: "runtime",
        timestamp: Date.now(),
      };
    }
  }

  async getCapabilities(_input?: { handle?: AcpRuntimeHandle }): Promise<AcpRuntimeCapabilities> {
    return {
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
      // Config options would be populated from acpx runtime capabilities
      configOptionKeys: undefined,
    };
  }

  async getStatus(input: { handle: AcpRuntimeHandle }): Promise<AcpRuntimeStatus> {
    const runtimeSessionName = input.handle.runtimeSessionName;

    // Query status from acpx
    const { stdout, stderr, exitCode } = await runAcpxCommand([
      "codex",
      "status",
      "--session",
      runtimeSessionName,
    ]);

    if (exitCode !== 0) {
      return {
        summary: `ACP session error: ${stderr || stdout || `exit code ${exitCode}`}`,
        details: {
          sessionKey: input.handle.sessionKey,
          runtimeSessionName: input.handle.runtimeSessionName,
          backend: "acpx",
          error: stderr || stdout,
        },
      };
    }

    // Parse status output
    // Expected format:
    // session: <uuid>
    // agent: npx @zed-industries/codex-acp
    // pid: <number>
    // status: running
    // uptime: 00:00:46
    // lastPromptTime: 2026-03-09T05:16:11.671Z

    const output = stdout;
    const status: AcpRuntimeStatus = {
      summary: `ACP session via acpx backend: ${runtimeSessionName}`,
      details: {
        sessionKey: input.handle.sessionKey,
        runtimeSessionName,
        backend: "acpx",
      },
    };

    // Parse session UUID
    const sessionMatch = output.match(/session:\s*([0-9a-f-]+)/i);
    if (sessionMatch) {
      status.backendSessionId = sessionMatch[1];
      status.details!["sessionId"] = sessionMatch[1];
    }

    // Parse agent - NOTE: This is command string, NOT agentSessionId
    const agentMatch = output.match(/agent:\s*(.+)/i);
    if (agentMatch) {
      status.details!["agent"] = agentMatch[1].trim();
      // DO NOT set agentSessionId - it's the command string, not a unique ID
    }

    // Parse pid
    const pidMatch = output.match(/pid:\s*(\d+)/i);
    if (pidMatch) {
      status.details!["pid"] = parseInt(pidMatch[1], 10);
    }

    // Parse status
    const statusMatch = output.match(/status:\s*(\w+)/i);
    if (statusMatch) {
      status.details!["status"] = statusMatch[1];
    }

    // Parse uptime
    const uptimeMatch = output.match(/uptime:\s*([\d:]+)/i);
    if (uptimeMatch) {
      status.details!["uptime"] = uptimeMatch[1];
    }

    // Parse lastPromptTime
    const lastPromptMatch = output.match(/lastPromptTime:\s*(.+)/i);
    if (lastPromptMatch) {
      status.details!["lastPromptTime"] = lastPromptMatch[1].trim();
    }

    return status;
  }

  async setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void> {
    const runtimeSessionName = input.handle.runtimeSessionName;
    const { stderr, exitCode } = await runAcpxCommand([
      "codex",
      "set-mode",
      input.mode,
      "--session",
      runtimeSessionName,
    ]);

    if (exitCode !== 0) {
      throw new Error(`Failed to set mode: ${stderr}`);
    }
  }

  async setConfigOption(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<void> {
    const runtimeSessionName = input.handle.runtimeSessionName;
    const { stderr, exitCode } = await runAcpxCommand([
      "codex",
      "set",
      input.key,
      input.value,
      "--session",
      runtimeSessionName,
    ]);

    if (exitCode !== 0) {
      throw new Error(`Failed to set config option: ${stderr}`);
    }
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    try {
      // Check if acpx binary is available
      const { stdout, exitCode } = await runAcpxCommand(["--version"]);

      if (exitCode === 0) {
        const versionMatch = stdout.match(/(\d+\.\d+\.\d+)/);
        return {
          ok: true,
          message: `ACPX runtime is installed (version ${versionMatch ? versionMatch[1] : "unknown"})`,
          details: ["Binary: acpx", `Version: ${versionMatch ? versionMatch[1] : "unknown"}`],
        };
      }

      return {
        ok: false,
        code: "ACPX_NOT_INSTALLED",
        message: "ACPX runtime is not installed",
        installCommand: "pnpm add -g acpx",
        details: [
          "The acpx runtime backend requires the acpx package to be installed globally.",
          "Run 'pnpm add -g acpx' to install the acpx CLI.",
        ],
      };
    } catch {
      return {
        ok: false,
        code: "ACPX_NOT_INSTALLED",
        message: "ACPX runtime is not available. Ensure acpx is in your PATH.",
        installCommand: "pnpm add -g acpx",
        details: [
          "The acpx runtime backend requires the acpx package to be installed globally.",
          "Run 'pnpm add -g acpx' to install the acpx CLI.",
        ],
      };
    }
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const runtimeSessionName = input.handle.runtimeSessionName;
    const { stderr, exitCode } = await runAcpxCommand([
      "codex",
      "cancel",
      "--session",
      runtimeSessionName,
    ]);

    if (exitCode !== 0) {
      // Cancel might fail if there's no active turn - that's okay
      if (!stderr.includes("no active")) {
        console.error(`[acpx] cancel warning: ${stderr}`);
      }
    }
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const runtimeSessionName = input.handle.runtimeSessionName;
    const { stderr, exitCode } = await runAcpxCommand([
      "codex",
      "sessions",
      "close",
      runtimeSessionName,
    ]);

    if (exitCode !== 0) {
      // Session might already be closed - that's okay
      if (!stderr.includes("not found") && !stderr.includes("already closed")) {
        throw new Error(`Failed to close ACPX session: ${stderr}`);
      }
    }
  }
}

/**
 * Create an instance of the ACPX runtime backend.
 */
export function createAcpxRuntimeBackend(): AcpRuntime {
  return new AcpxRuntimeBackend();
}

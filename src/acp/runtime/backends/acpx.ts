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
 * Note: This is a stub implementation that provides the interface contract.
 * Full acpx implementation would require the acpx package to be installed
 * and properly configured.
 */
export class AcpxRuntimeBackend implements AcpRuntime {
  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    // Generate a unique session identifier
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const runtimeSessionName = `acpx-${input.sessionKey}-${timestamp}-${randomSuffix}`;

    return {
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName,
      cwd: input.cwd,
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncGenerator<AcpRuntimeEvent> {
    // Emit started event
    yield {
      type: "started",
      requestId: input.requestId,
      timestamp: Date.now(),
    };

    // Emit status indicating the turn is being processed
    yield {
      type: "status",
      text: "Processing turn via acpx backend...",
      timestamp: Date.now(),
    };

    // TODO: Once acpx is properly integrated, this would:
    // 1. Forward the input.text to the acpx runtime
    // 2. Stream events back from acpx
    // 3. Map acpx events to AcpRuntimeEvent types

    // For now, emit a done event to satisfy the contract
    yield {
      type: "done",
      stopReason: "stub",
      timestamp: Date.now(),
    };
  }

  async getCapabilities(_input?: { handle?: AcpRuntimeHandle }): Promise<AcpRuntimeCapabilities> {
    return {
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
      // Config options would be populated from acpx runtime capabilities
      configOptionKeys: undefined,
    };
  }

  async getStatus(input: { handle: AcpRuntimeHandle }): Promise<AcpRuntimeStatus> {
    // TODO: Query actual status from acpx runtime
    return {
      summary: `ACP session via acpx backend (stub): ${input.handle.runtimeSessionName}`,
      details: {
        sessionKey: input.handle.sessionKey,
        runtimeSessionName: input.handle.runtimeSessionName,
        backend: "acpx",
        stub: true,
      },
    };
  }

  async setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void> {
    // TODO: Forward to acpx runtime
    console.log(
      `[acpx] setMode: ${input.mode} for session ${input.handle.runtimeSessionName} (stub)`,
    );
  }

  async setConfigOption(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<void> {
    // TODO: Forward to acpx runtime
    console.log(
      `[acpx] setConfigOption: ${input.key}=${input.value} for session ${input.handle.runtimeSessionName} (stub)`,
    );
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    // TODO: Check if acpx binary/package is available
    return {
      ok: false,
      code: "ACPX_NOT_INSTALLED",
      message: "ACPX runtime is not installed. Install with: pnpm add -g acpx",
      installCommand: "pnpm add -g acpx",
      details: [
        "The acpx runtime backend requires the acpx package to be installed globally.",
        "Run 'pnpm add -g acpx' to install the acpx CLI.",
      ],
    };
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    // TODO: Forward cancel to acpx runtime
    console.log(
      `[acpx] cancel: session ${input.handle.runtimeSessionName}${
        input.reason ? `, reason: ${input.reason}` : ""
      }`,
    );
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    // TODO: Forward close to acpx runtime
    console.log(
      `[acpx] close: session ${input.handle.runtimeSessionName}, reason: ${input.reason}`,
    );
  }
}

/**
 * Create an instance of the ACPX runtime backend.
 */
export function createAcpxRuntimeBackend(): AcpRuntime {
  return new AcpxRuntimeBackend();
}

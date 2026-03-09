import pc from "picocolors";
import type { MoziConfig } from "../../config";
import { logger } from "../../logger";
import { AcpxRuntimeBackend } from "./backends/acpx";
import { registerAcpRuntimeBackend } from "./registry";

const ACPX_BACKEND_ID = "acpx";

let acpxBackendRegistered = false;

/**
 * Bootstrap ACP runtime backends with error handling for CLI commands.
 *
 * This helper wraps bootstrapAcpRuntimeBackends with standard error handling
 * including console output and process.exit(1) on failure.
 *
 * @param config - The Mozi configuration
 * @param backendIdOverride - Optional backend ID override
 * @returns Promise that resolves when bootstrap succeeds (never returns on failure)
 */
export async function bootstrapAcpRuntimeBackendsOrExit(
  config: MoziConfig,
  backendIdOverride?: string,
): Promise<void> {
  try {
    await bootstrapAcpRuntimeBackends(config, backendIdOverride);
  } catch (err) {
    console.error(
      pc.red(
        `Error: failed to bootstrap ACP runtime: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
  }
}

/**
 * Bootstrap the ACP runtime backends based on configuration.
 *
 * This is called during runtime initialization to register
 * the configured ACP backend (e.g., acpx).
 */
export async function bootstrapAcpRuntimeBackends(
  config: MoziConfig,
  backendIdOverride?: string,
): Promise<void> {
  const acpConfig = config.acp;

  // If ACP is not enabled, skip backend registration
  if (!acpConfig?.enabled) {
    logger.debug({ acpConfig }, "ACP not enabled, skipping runtime backend bootstrap");
    return;
  }

  // Determine which backend to register
  const backendId = (backendIdOverride ?? acpConfig.backend)?.trim().toLowerCase();

  if (!backendId) {
    logger.debug("No ACP backend configured, skipping runtime backend bootstrap");
    return;
  }

  // Prevent duplicate registration
  if (isAcpBackendRegistered(backendId)) {
    logger.debug(
      { backendId },
      "ACP runtime backend already registered, skipping duplicate registration",
    );
    return;
  }

  // Register the appropriate backend based on config
  if (backendId === ACPX_BACKEND_ID) {
    await registerAcpxBackend();
  } else {
    logger.warn({ backendId }, "Unknown ACP backend configured, no runtime will be registered");
  }
}

/**
 * Register the acpx backend with the ACP runtime registry.
 */
async function registerAcpxBackend(): Promise<void> {
  try {
    const runtime = new AcpxRuntimeBackend();

    registerAcpRuntimeBackend({
      id: ACPX_BACKEND_ID,
      runtime,
      healthy: () => {
        // Keep bootstrap health deterministic for the current stub backend.
        // The runtime doctor report remains the source of installation guidance.
        return true;
      },
    });

    acpxBackendRegistered = true;
    logger.info({ backendId: ACPX_BACKEND_ID }, "ACPX runtime backend registered successfully");
  } catch (error) {
    logger.error({ err: error }, "Failed to register ACPX runtime backend");
    throw error;
  }
}

/**
 * Check if an ACP backend is registered for the given backend id.
 */
export function isAcpBackendRegistered(backendId?: string): boolean {
  if (!backendId) {
    return acpxBackendRegistered;
  }
  return acpxBackendRegistered && backendId.trim().toLowerCase() === ACPX_BACKEND_ID;
}

export const __testing = {
  resetAcpBackendRegisteredForTests() {
    acpxBackendRegistered = false;
  },
};

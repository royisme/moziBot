import pc from "picocolors";
import { createAcpBridgeRuntimeAdapter } from "../../acp/bridge/runtime-adapter-impl";
import { serveAcpBridge } from "../../acp/bridge/server";
import { loadConfig } from "../../config/loader";
import { isAcpEnabledByPolicy } from "../../config/schema/acp-policy";

export type AcpBridgeOptions = {
  config?: string;
  defaultSession?: string;
  verbose?: boolean;
};

/**
 * Starts the ACP Bridge server.
 * This is used internally by the ACP client to communicate with the moziBot runtime.
 */
export async function acpBridge(options: AcpBridgeOptions): Promise<void> {
  const configPath = options.config;
  const configResult = loadConfig(configPath);

  if (!configResult.success || !configResult.config) {
    console.error(pc.red("Error: failed to load configuration."));
    for (const error of configResult.errors ?? []) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  const config = configResult.config;

  // Check ACP policy
  if (!isAcpEnabledByPolicy(config)) {
    console.error(pc.red("Error: ACP is disabled by policy."));
    process.exit(1);
  }

  const verbose = options.verbose ?? false;

  if (verbose) {
    console.log(pc.dim("Starting ACP Bridge server..."));
  }

  // Create runtime adapter
  const adapter = createAcpBridgeRuntimeAdapter({
    config,
    defaultSessionKey: options.defaultSession,
    verbose,
  });

  // Start the bridge
  try {
    await serveAcpBridge({
      adapter,
      defaultSessionKey: options.defaultSession,
      verbose,
    });
  } catch (err) {
    console.error(pc.red(`Bridge error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

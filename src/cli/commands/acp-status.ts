import pc from "picocolors";
import { loadConfig } from "../../config/loader";
import { isAcpEnabledByPolicy } from "../../config/schema/acp-policy";
import { getAcpRuntimeBackend } from "../../acp/runtime/registry";
import { resolveSessionKey } from "../../acp/session-key-utils";
import { readAcpSessionEntry } from "../../acp/runtime/session-meta";

export type AcpStatusOptions = {
  config?: string;
  json?: boolean;
};

/**
 * Shows the status of an ACP session.
 */
export async function acpStatus(
  sessionKeyOrLabel: string,
  options: AcpStatusOptions,
): Promise<void> {
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

  const sessionKey =
    (await resolveSessionKey({
      keyOrLabel: sessionKeyOrLabel,
      config,
    })) ?? sessionKeyOrLabel.trim();

  // Read session metadata
  const sessionEntry = readAcpSessionEntry({ sessionKey });
  const meta = sessionEntry?.acp;

  if (!meta) {
    console.error(pc.red(`Error: session "${sessionKeyOrLabel}" not found.`));
    process.exit(1);
  }

  // Get runtime backend
  const backend = getAcpRuntimeBackend(meta.backend);

  if (options.json) {
    // Output as JSON
    const status = {
      sessionKey,
      backend: meta.backend,
      agent: meta.agent,
      state: meta.state,
      mode: meta.mode,
      runtimeSessionName: meta.runtimeSessionName,
      cwd: meta.cwd,
      identity: meta.identity,
      lastActivityAt: meta.lastActivityAt,
      lastError: meta.lastError,
    };
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  // Human-readable output
  console.log(pc.bold("ACP Session Status"));
  console.log(pc.dim("=".repeat(40)));
  console.log(`  Session Key: ${pc.cyan(sessionKey)}`);
  console.log(`  Runtime Name: ${pc.cyan(meta.runtimeSessionName)}`);
  console.log(`  Backend: ${pc.cyan(meta.backend)}`);
  console.log(`  Agent: ${pc.cyan(meta.agent)}`);
  console.log(`  State: ${formatState(meta.state)}`);
  console.log(`  Mode: ${pc.cyan(meta.mode)}`);

  if (meta.cwd) {
    console.log(`  Working Directory: ${pc.cyan(meta.cwd)}`);
  }

  if (meta.identity) {
    console.log("");
    console.log(pc.bold("  Identity:"));
    if (meta.identity.acpxRecordId) {
      console.log(`    ACXP Record ID: ${pc.dim(meta.identity.acpxRecordId)}`);
    }
    if (meta.identity.acpxSessionId) {
      console.log(`    ACXP Session ID: ${pc.dim(meta.identity.acpxSessionId)}`);
    }
    if (meta.identity.agentSessionId) {
      console.log(`    Agent Session ID: ${pc.dim(meta.identity.agentSessionId)}`);
    }
    console.log(`    Source: ${pc.dim(meta.identity.source)}`);
    console.log(
      `    Last Updated: ${pc.dim(new Date(meta.identity.lastUpdatedAt).toLocaleString())}`,
    );
  }

  console.log("");
  console.log(`  Last Activity: ${pc.dim(new Date(meta.lastActivityAt).toLocaleString())}`);

  if (meta.lastError) {
    console.log("");
    console.log(pc.red(`  Last Error: ${meta.lastError}`));
  }

  // Try to get runtime status if available
  if (backend && meta.identity?.agentSessionId) {
    try {
      const handle = {
        sessionKey,
        backend: meta.backend,
        runtimeSessionName: meta.runtimeSessionName,
        cwd: meta.cwd,
        backendSessionId: meta.identity.acpxSessionId,
        agentSessionId: meta.identity.agentSessionId,
      };

      if (backend.runtime.getStatus) {
        const runtimeStatus = await backend.runtime.getStatus({ handle });
        if (runtimeStatus) {
          console.log("");
          console.log(pc.bold("  Runtime Status:"));
          if (runtimeStatus.summary) {
            console.log(`    Summary: ${pc.dim(runtimeStatus.summary)}`);
          }
          if (runtimeStatus.details) {
            for (const [key, value] of Object.entries(runtimeStatus.details)) {
              console.log(`    ${key}: ${pc.dim(String(value))}`);
            }
          }
        }
      }
    } catch (err) {
      console.log(pc.yellow(`  (Runtime status unavailable: ${err instanceof Error ? err.message : String(err)})`));
    }
  }
}

function formatState(state: string): string {
  switch (state) {
    case "running":
      return pc.green("running");
    case "idle":
      return pc.blue("idle");
    case "error":
      return pc.red("error");
    default:
      return pc.dim(state);
  }
}

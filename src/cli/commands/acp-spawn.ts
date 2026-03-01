import pc from "picocolors";
import { requireAcpRuntimeBackend } from "../../acp/runtime/registry";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta";
import type { SessionAcpMeta } from "../../acp/types";
import { loadConfig } from "../../config/loader";
import { isAcpEnabledByPolicy, isAcpDispatchEnabledByPolicy } from "../../config/schema/acp-policy";

export type AcpSpawnOptions = {
  config?: string;
  agent?: string;
  mode?: string;
  cwd?: string;
};

/**
 * Spawns a new ACP session.
 */
export async function acpSpawn(
  backend: string | undefined,
  options: AcpSpawnOptions,
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
    console.error(pc.dim("Set `acp.enabled=true` in your config to enable ACP."));
    process.exit(1);
  }

  if (!isAcpDispatchEnabledByPolicy(config)) {
    console.error(pc.red("Error: ACP dispatch is disabled by policy."));
    console.error(pc.dim("Set `acp.dispatch.enabled=true` in your config to enable dispatch."));
    process.exit(1);
  }

  // Resolve agent
  const agent =
    options.agent ??
    config.acp?.defaultAgent ??
    config.acp?.allowedAgents?.[0] ??
    findDefaultAgentId(config.agents);

  if (!agent) {
    console.error(pc.red("Error: no agent specified and no default agent found."));
    process.exit(1);
  }

  const resolvedBackend = (backend ?? config.acp?.backend ?? "").trim();
  if (!resolvedBackend) {
    console.error(pc.red("Error: backend is required."));
    console.error(pc.dim("Pass `mozi acp spawn <backend>` or set `acp.backend` in config."));
    process.exit(1);
  }

  const modeInput = (options.mode ?? "persistent").trim().toLowerCase();
  if (modeInput !== "persistent" && modeInput !== "oneshot") {
    console.error(pc.red(`Error: invalid mode "${options.mode}".`));
    console.error(pc.dim("Mode must be one of: persistent, oneshot."));
    process.exit(1);
  }

  // Require runtime backend
  let runtimeBackend;
  try {
    runtimeBackend = requireAcpRuntimeBackend(resolvedBackend);
  } catch (err) {
    console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  // Generate session key
  const sessionKey = `acp:${Date.now()}:${process.pid}`;
  const cwd = options.cwd ?? process.cwd();
  const mode = modeInput;

  // Initialize session metadata
  const now = Date.now();
  const meta: SessionAcpMeta = {
    backend: runtimeBackend.id,
    agent,
    runtimeSessionName: sessionKey,
    mode,
    cwd,
    state: "idle",
    lastActivityAt: now,
  };

  try {
    // Ensure session in runtime
    const handle = await runtimeBackend.runtime.ensureSession({
      sessionKey,
      agent,
      mode,
      cwd,
    });

    // Write session metadata
    upsertAcpSessionMeta({
      sessionKey,
      mutate: () => ({
        ...meta,
        identity: {
          state: "resolved",
          acpxRecordId: handle.acpxRecordId,
          acpxSessionId: handle.backendSessionId,
          agentSessionId: handle.agentSessionId,
          source: "ensure",
          lastUpdatedAt: now,
        },
      }),
    });

    console.log(pc.green("ACP session spawned successfully"));
    console.log(`  Session Key: ${pc.cyan(sessionKey)}`);
    console.log(`  Backend: ${pc.cyan(runtimeBackend.id)}`);
    console.log(`  Agent: ${pc.cyan(agent)}`);
    console.log(`  Mode: ${pc.cyan(mode)}`);
    console.log(`  Working Directory: ${pc.cyan(cwd)}`);
    console.log("");
    console.log(pc.dim("Use `mozi acp status <sessionKey>` to check session status."));
    console.log(pc.dim("Use `mozi acp cancel <sessionKey>` to cancel the session."));
  } catch (err) {
    console.error(
      pc.red(`Error spawning session: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }
}

function findDefaultAgentId(agents?: Record<string, unknown>): string | null {
  if (!agents) {
    return null;
  }

  const agentIds = Object.keys(agents);
  if (agentIds.length === 0) {
    return null;
  }

  // Look for main agent
  const mainAgent = agentIds.find((id) => {
    const agent = agents[id];
    return (
      agent &&
      typeof agent === "object" &&
      "main" in agent &&
      (agent as Record<string, unknown>).main === true
    );
  });

  if (mainAgent) {
    return mainAgent;
  }

  // Return first non-default agent
  const nonDefault = agentIds.find((id) => id !== "defaults");
  if (nonDefault) {
    return nonDefault;
  }

  return agentIds[0] ?? null;
}

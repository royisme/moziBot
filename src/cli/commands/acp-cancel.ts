import pc from "picocolors";
import { loadConfig } from "../../config/loader";
import { isAcpEnabledByPolicy } from "../../config/schema/acp-policy";
import { getAcpRuntimeBackend } from "../../acp/runtime/registry";
import { resolveSessionKey } from "../../acp/session-key-utils";
import { readAcpSessionEntry, upsertAcpSessionMeta } from "../../acp/runtime/session-meta";

export type AcpCancelOptions = {
  config?: string;
};

/**
 * Cancels a running ACP session.
 */
export async function acpCancel(
  sessionKeyOrLabel: string,
  options: AcpCancelOptions,
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

  // Get runtime backend from session metadata
  const sessionEntry = readAcpSessionEntry({ sessionKey });
  const meta = sessionEntry?.acp;

  if (!meta) {
    console.error(pc.red(`Error: session "${sessionKeyOrLabel}" not found.`));
    process.exit(1);
  }

  const backendId = meta.backend;

  const backend = getAcpRuntimeBackend(backendId);
  if (!backend) {
    console.error(pc.red(`Error: backend "${backendId}" not available.`));
    process.exit(1);
  }

  try {
    // Check if session is running
    if (meta.state !== "running") {
      console.log(pc.yellow(`Session "${sessionKey}" is not running (state: ${meta.state}).`));
      return;
    }

    // Close the session in the runtime
    if (meta.identity?.agentSessionId) {
      const handle = {
        sessionKey,
        backend: backendId,
        runtimeSessionName: meta.runtimeSessionName,
        cwd: meta.cwd,
        backendSessionId: meta.identity.acpxSessionId,
        agentSessionId: meta.identity.agentSessionId,
      };

      await backend.runtime.close({
        handle,
        reason: "cancelled-by-user",
      });
    }

    upsertAcpSessionMeta({
      sessionKey,
      mutate: (current) => {
        if (!current) return null;
        return {
          ...current,
          state: "idle",
          lastActivityAt: Date.now(),
        };
      },
    });

    console.log(pc.green(`Session "${sessionKey}" cancelled successfully.`));
  } catch (err) {
    console.error(pc.red(`Error cancelling session: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

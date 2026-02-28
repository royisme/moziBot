import pc from "picocolors";
import { loadConfig } from "../../config/loader";
import { isAcpEnabledByPolicy } from "../../config/schema/acp-policy";
import { listAcpSessionEntries } from "../../acp/runtime/session-meta";

export type AcpListOptions = {
  config?: string;
  json?: boolean;
};

/**
 * Lists all ACP sessions.
 */
export async function acpList(options: AcpListOptions): Promise<void> {
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

  // List sessions
  const sessions = listAcpSessionEntries();

  if (options.json) {
    // Output as JSON
    const result = sessions.map((session) => ({
      sessionKey: session.sessionKey,
      backend: session.acp?.backend,
      agent: session.acp?.agent,
      state: session.acp?.state,
      mode: session.acp?.mode,
      runtimeSessionName: session.acp?.runtimeSessionName,
      cwd: session.acp?.cwd,
      lastActivityAt: session.acp?.lastActivityAt,
      lastError: session.acp?.lastError,
    }));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable output
  console.log(pc.bold("ACP Sessions"));
  console.log(pc.dim("=".repeat(60)));

  if (sessions.length === 0) {
    console.log(pc.dim("  No ACP sessions found."));
    console.log("");
    console.log(
      pc.dim("  Use `mozi acp spawn <backend>` to create a new session."),
    );
    return;
  }

  for (const session of sessions) {
    const acp = session.acp;
    if (!acp) continue;

    console.log("");
    console.log(pc.bold(`  ${session.sessionKey}`));
    console.log(`    Runtime: ${pc.cyan(acp.runtimeSessionName)}`);
    console.log(`    Backend: ${pc.cyan(acp.backend)}`);
    console.log(`    Agent: ${pc.cyan(acp.agent)}`);
    console.log(`    State: ${formatState(acp.state)}`);
    console.log(`    Mode: ${pc.cyan(acp.mode)}`);

    if (acp.cwd) {
      console.log(`    CWD: ${pc.dim(acp.cwd)}`);
    }

    console.log(
      `    Last Activity: ${pc.dim(new Date(acp.lastActivityAt).toLocaleString())}`,
    );

    if (acp.lastError) {
      console.log(`    ${pc.red(`Error: ${acp.lastError}`)}`);
    }
  }

  console.log("");
  console.log(pc.dim(`  Total: ${sessions.length} session(s)`));
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

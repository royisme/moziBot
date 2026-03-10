import pc from "picocolors";
import { loadConfig } from "../../config/loader";
import { isAcpEnabledByPolicy } from "../../config/schema/acp-policy";
import { DetachedRunRegistry } from "../../runtime/host/sessions/spawn";
import { resolveRuntimePaths } from "./runtime-paths";

export type SubagentStatusOptions = {
  config?: string;
  json?: boolean;
};

/**
 * Shows the status of a specific subagent run.
 */
export async function subagentStatus(runId: string, options: SubagentStatusOptions): Promise<void> {
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

  // Initialize detached run registry
  const runtimePaths = resolveRuntimePaths(configPath);
  const dataDir = runtimePaths.dataDir;
  const registry = new DetachedRunRegistry(dataDir);

  const run = registry.get(runId);

  if (!run) {
    console.error(pc.red(`Error: run "${runId}" not found.`));
    process.exit(1);
  }

  if (options.json) {
    const result = {
      runId: run.runId,
      kind: run.kind,
      childKey: run.childKey,
      parentKey: run.parentKey,
      task: run.task,
      label: run.label,
      cleanup: run.cleanup,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      result: run.result,
      error: run.error,
      timeoutSeconds: run.timeoutSeconds,
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable output
  console.log(pc.bold("Subagent Run Status"));
  console.log(pc.dim("=".repeat(40)));
  console.log(`  Run ID: ${pc.cyan(run.runId)}`);
  console.log(`  Task: ${pc.cyan(truncate(run.task, 60))}`);
  if (run.label) {
    console.log(`  Label: ${pc.cyan(run.label)}`);
  }
  console.log(`  Kind: ${pc.cyan(run.kind)}`);
  console.log(`  Status: ${formatStatus(run.status)}`);
  console.log(`  Cleanup: ${pc.cyan(run.cleanup)}`);

  console.log("");
  console.log(pc.bold("  Timing:"));
  console.log(`    Created: ${pc.dim(new Date(run.createdAt).toLocaleString())}`);
  if (run.startedAt) {
    console.log(`    Started: ${pc.dim(new Date(run.startedAt).toLocaleString())}`);
  }
  if (run.endedAt) {
    console.log(`    Ended: ${pc.dim(new Date(run.endedAt).toLocaleString())}`);
    const duration = run.startedAt ? run.endedAt - run.startedAt : null;
    if (duration) {
      const seconds = Math.round(duration / 1000);
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      console.log(`    Duration: ${pc.dim(mins > 0 ? `${mins}m ${secs}s` : `${secs}s`)}`);
    }
  }

  if (run.timeoutSeconds) {
    console.log("");
    console.log(`  Timeout: ${pc.cyan(`${run.timeoutSeconds}s`)}`);
  }

  if (run.result) {
    console.log("");
    console.log(pc.bold("  Result:"));
    console.log(`    ${pc.dim(truncate(run.result, 500))}`);
  }

  if (run.error) {
    console.log("");
    console.log(pc.red(`  Error: ${run.error}`));
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str;
  }
  return str.slice(0, maxLen - 3) + "...";
}

function formatStatus(status: string): string {
  switch (status) {
    case "accepted":
      return pc.blue("accepted");
    case "started":
      return pc.yellow("started");
    case "streaming":
      return pc.yellow("streaming");
    case "completed":
      return pc.green("completed");
    case "failed":
      return pc.red("failed");
    case "timeout":
      return pc.red("timeout");
    case "aborted":
      return pc.red("aborted");
    default:
      return pc.dim(status);
  }
}

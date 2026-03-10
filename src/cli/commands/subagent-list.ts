import pc from "picocolors";
import { loadConfig } from "../../config/loader";
import { isAcpEnabledByPolicy } from "../../config/schema/acp-policy";
import { DetachedRunRegistry } from "../../runtime/host/sessions/spawn";
import { resolveRuntimePaths } from "./runtime-paths";

export type SubagentListOptions = {
  config?: string;
  json?: boolean;
  all?: boolean;
};

/**
 * Lists all subagent runs.
 */
export async function subagentList(options: SubagentListOptions): Promise<void> {
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

  // Check ACP policy (subagent uses similar permissions)
  if (!isAcpEnabledByPolicy(config)) {
    console.error(pc.red("Error: ACP is disabled by policy."));
    process.exit(1);
  }

  // Initialize detached run registry
  const runtimePaths = resolveRuntimePaths(configPath);
  const dataDir = runtimePaths.dataDir;
  const registry = new DetachedRunRegistry(dataDir);

  const runs = options.all ? registry.listAll() : registry.listActive();

  if (options.json) {
    const result = runs.map((run) => ({
      runId: run.runId,
      kind: run.kind,
      childKey: run.childKey,
      parentKey: run.parentKey,
      task: run.task,
      label: run.label,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      error: run.error,
    }));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable output
  console.log(pc.bold("Subagent Runs"));
  console.log(pc.dim("=".repeat(60)));

  if (runs.length === 0) {
    console.log(pc.dim("  No subagent runs found."));
    console.log("");
    return;
  }

  for (const run of runs) {
    console.log("");
    console.log(pc.bold(`  ${run.runId}`));
    console.log(`    Task: ${pc.cyan(truncate(run.task, 50))}`);
    if (run.label) {
      console.log(`    Label: ${pc.cyan(run.label)}`);
    }
    console.log(`    Kind: ${pc.cyan(run.kind)}`);
    console.log(`    Status: ${formatStatus(run.status)}`);
    console.log(`    Created: ${pc.dim(new Date(run.createdAt).toLocaleString())}`);

    if (run.startedAt) {
      console.log(`    Started: ${pc.dim(new Date(run.startedAt).toLocaleString())}`);
    }
    if (run.endedAt) {
      console.log(`    Ended: ${pc.dim(new Date(run.endedAt).toLocaleString())}`);
    }
    if (run.error) {
      console.log(`    ${pc.red(`Error: ${truncate(run.error, 80)}`)}`);
    }
  }

  console.log("");
  console.log(pc.dim(`  Total: ${runs.length} run(s)`));
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

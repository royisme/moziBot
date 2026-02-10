import { z } from "zod";
import type {
  EnhancedSubAgentRegistry,
  SubAgentRunRecord,
} from "../../runtime/host/sessions/subagent-registry";

const inputSchema = z.object({
  runId: z.string().optional().describe("Specific run ID to check"),
  parentKey: z.string().optional().describe("List all runs for a parent session"),
});

export type SessionsStatusInput = z.infer<typeof inputSchema>;

export interface SessionsStatusResult {
  success: boolean;
  error?: string;
  count?: number;
  run?: FormattedRun;
  runs?: FormattedRun[];
}

interface FormattedRun {
  runId: string;
  label: string;
  status: string;
  runtime: string;
  error?: string;
}

function formatRun(run: SubAgentRunRecord): FormattedRun {
  return {
    runId: run.runId,
    label: run.label || run.task.slice(0, 50),
    status: run.status,
    runtime: run.startedAt
      ? run.endedAt
        ? `${Math.round((run.endedAt - run.startedAt) / 1000)}s`
        : `${Math.round((Date.now() - run.startedAt) / 1000)}s (running)`
      : "pending",
    error: run.error,
  };
}

export async function sessionsStatus(
  registry: EnhancedSubAgentRegistry,
  input: SessionsStatusInput,
): Promise<SessionsStatusResult> {
  const { runId, parentKey } = input;

  if (runId) {
    const run = registry.get(runId);
    if (!run) {
      return { success: false, error: `Run not found: ${runId}` };
    }
    return { success: true, run: formatRun(run) };
  }

  if (parentKey) {
    const runs = registry.listByParent(parentKey);
    return {
      success: true,
      count: runs.length,
      runs: runs.map(formatRun),
    };
  }

  const runs = registry.listAll();
  return {
    success: true,
    count: runs.length,
    runs: runs.map(formatRun),
  };
}

export const sessionsStatusSchema = inputSchema;

export const sessionsStatusDescription =
  "Check the status of spawned subagent tasks. " +
  "Use without arguments to list all active runs. " +
  "Use with runId to check a specific run. " +
  "Use with parentKey to list all runs spawned by a specific session.";

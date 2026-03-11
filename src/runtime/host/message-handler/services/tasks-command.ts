import type { InlineButton } from "../../../adapters/channels/types";
import type { TasksControlPlane, TaskRunView } from "./tasks-control-plane";

interface SendChannel {
  send(peerId: string, payload: { text: string; buttons?: InlineButton[][] }): Promise<unknown>;
}

function summarizeRun(run: TaskRunView): string {
  const label = run.label ? `${run.label} — ` : "";
  const live = run.live ? ` [live:${run.runtimeState ?? run.status}]` : "";
  return `- ${run.runId}: ${label}${run.status}${live}`;
}

function buildListButtons(runs: TaskRunView[]): InlineButton[][] {
  const rows: InlineButton[][] = runs.flatMap((run) => [
    [
      { text: `Status ${run.runId}`, callbackData: `/tasks status ${run.runId}` },
      { text: `Stop ${run.runId}`, callbackData: `/tasks stop ${run.runId}` },
    ],
  ]);
  rows.push([
    { text: "Refresh", callbackData: "/tasks" },
    { text: "Reconcile", callbackData: "/tasks reconcile" },
  ]);
  return rows;
}

function renderList(runs: TaskRunView[]): string {
  if (runs.length === 0) {
    return "No detached tasks for this session.";
  }
  return [`Tasks (${runs.length})`, ...runs.map(summarizeRun)].join("\n");
}

function renderDetail(run: TaskRunView): string {
  return [
    `Run: ${run.runId}`,
    `Task: ${run.label ?? run.task}`,
    `Status: ${run.status}`,
    `Runtime: ${run.live ? (run.runtimeState ?? "live") : "persistent-only"}`,
    `Kind: ${run.kind}`,
    `Created: ${new Date(run.createdAt).toISOString()}`,
    run.startedAt ? `Started: ${new Date(run.startedAt).toISOString()}` : undefined,
    run.endedAt ? `Ended: ${new Date(run.endedAt).toISOString()}` : undefined,
    run.abortRequestedAt
      ? `Abort requested: ${new Date(run.abortRequestedAt).toISOString()} by ${run.abortRequestedBy ?? "unknown"}`
      : undefined,
    run.staleDetectedAt
      ? `Stale detected: ${new Date(run.staleDetectedAt).toISOString()}`
      : undefined,
    run.error ? `Error: ${run.error}` : undefined,
    run.result ? `Result: ${run.result}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function handleTasksCommand(params: {
  sessionKey: string;
  args: string;
  channel: SendChannel;
  peerId: string;
  controlPlane: TasksControlPlane;
}): Promise<void> {
  const { sessionKey, args, channel, peerId, controlPlane } = params;
  const trimmed = args.trim();
  if (!trimmed) {
    const runs = controlPlane.listForParent(sessionKey);
    await channel.send(peerId, {
      text: renderList(runs),
      ...(runs.length > 0 ? { buttons: buildListButtons(runs) } : {}),
    });
    return;
  }

  const [subcommand, runId] = trimmed.split(/\s+/, 2);
  if (subcommand === "status") {
    if (!runId) {
      await channel.send(peerId, { text: "Usage: /tasks status <runId>" });
      return;
    }
    const run = controlPlane.getDetail(runId, sessionKey);
    if (!run) {
      await channel.send(peerId, { text: `Run not found: ${runId}` });
      return;
    }
    await channel.send(peerId, {
      text: renderDetail(run),
      buttons: [
        [{ text: "Back", callbackData: "/tasks" }],
        [{ text: `Stop ${run.runId}`, callbackData: `/tasks stop ${run.runId}` }],
      ],
    });
    return;
  }

  if (subcommand === "stop") {
    if (!runId) {
      await channel.send(peerId, { text: "Usage: /tasks stop <runId>" });
      return;
    }
    const result = await controlPlane.stop(runId, sessionKey, "user");
    const runs = controlPlane.listForParent(sessionKey);
    await channel.send(peerId, {
      text: `${result.message}\n\n${renderList(runs)}`,
      ...(runs.length > 0 ? { buttons: buildListButtons(runs) } : {}),
    });
    return;
  }

  if (subcommand === "reconcile") {
    const result = await controlPlane.reconcile(sessionKey, "user");
    const runs = controlPlane.listForParent(sessionKey);
    await channel.send(peerId, {
      text: `${result.message}\n\n${renderList(runs)}`,
      ...(runs.length > 0 ? { buttons: buildListButtons(runs) } : {}),
    });
    return;
  }

  await channel.send(peerId, {
    text: "Usage: /tasks [status <runId>|stop <runId>|reconcile]",
  });
}

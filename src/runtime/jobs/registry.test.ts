import { describe, expect, it, vi } from "vitest";
import { InMemoryAgentJobRegistry } from "./registry";

function createRegistry(now = vi.fn(() => 1_000)) {
  return new InMemoryAgentJobRegistry({ snapshotTtlMs: 100, now });
}

function createJob(id = "job-1") {
  return {
    id,
    sessionKey: "agent:mozi:telegram:dm:user-1",
    agentId: "mozi",
    channelId: "telegram",
    peerId: "user-1",
    source: "reminder" as const,
    kind: "scheduled" as const,
    prompt: "ping",
  };
}

describe("InMemoryAgentJobRegistry", () => {
  it("creates_and_lists_active_jobs", () => {
    const registry = createRegistry();
    const job = registry.create(createJob());

    expect(job.status).toBe("queued");
    expect(registry.get(job.id)?.id).toBe(job.id);
    expect(registry.listActiveBySession(job.sessionKey)).toHaveLength(1);
    expect(registry.listEvents(job.id).map((event) => event.type)).toEqual(["job_queued"]);
  });

  it("rejects_illegal_status_transition", () => {
    const registry = createRegistry();
    const job = registry.create(createJob());

    expect(() => registry.updateStatus(job.id, "completed")).toThrow(
      "Illegal AgentJob transition: queued -> completed",
    );
  });

  it("supports_valid_transitions_and_records_events", () => {
    const now = vi.fn(() => 1_000);
    const registry = createRegistry(now);
    const job = registry.create(createJob());

    now.mockReturnValueOnce(1_100);
    const running = registry.updateStatus(job.id, "running");
    now.mockReturnValueOnce(1_200);
    const waiting = registry.updateStatus(job.id, "waiting");
    now.mockReturnValueOnce(1_300);
    const resumed = registry.updateStatus(job.id, "running");
    now.mockReturnValueOnce(1_400);
    const completed = registry.updateStatus(job.id, "completed", { resultSummary: "done" });

    expect(running.startedAt).toBe(1_100);
    expect(waiting.status).toBe("waiting");
    expect(resumed.status).toBe("running");
    expect(completed.finishedAt).toBe(1_400);
    expect(registry.listEvents(job.id).map((event) => event.type)).toEqual([
      "job_queued",
      "job_started",
      "job_waiting",
      "job_started",
      "job_completed",
    ]);
  });

  it("wait_for_job_returns_existing_snapshot_immediately", async () => {
    const now = vi.fn(() => 1_000);
    const registry = createRegistry(now);
    const job = registry.create(createJob());

    registry.updateStatus(job.id, "running", { startedAt: 1_010 });
    registry.updateStatus(job.id, "completed", { finishedAt: 1_020, resultSummary: "done" });
    registry.complete(job.id, {
      id: job.id,
      status: "completed",
      startedAt: 1_010,
      finishedAt: 1_020,
      resultSummary: "done",
      ts: 1_020,
    });

    await expect(registry.waitForJob({ jobId: job.id, timeoutMs: 10 })).resolves.toEqual({
      id: job.id,
      status: "completed",
      startedAt: 1_010,
      finishedAt: 1_020,
      resultSummary: "done",
      ts: 1_020,
    });
  });

  it("wait_for_job_times_out_when_snapshot_missing", async () => {
    const registry = createRegistry();

    await expect(registry.waitForJob({ jobId: "missing", timeoutMs: 1 })).resolves.toBeNull();
  });

  it("wait_for_job_resolves_when_completed_later", async () => {
    const now = vi.fn(() => 1_000);
    const registry = createRegistry(now);
    const job = registry.create(createJob());

    const waiting = registry.waitForJob({ jobId: job.id, timeoutMs: 1000 });

    registry.updateStatus(job.id, "running", { startedAt: 1_010 });
    registry.updateStatus(job.id, "completed", { finishedAt: 1_020, resultSummary: "done" });
    registry.complete(job.id, {
      id: job.id,
      status: "completed",
      startedAt: 1_010,
      finishedAt: 1_020,
      resultSummary: "done",
      ts: 1_020,
    });

    await expect(waiting).resolves.toEqual({
      id: job.id,
      status: "completed",
      startedAt: 1_010,
      finishedAt: 1_020,
      resultSummary: "done",
      ts: 1_020,
    });
  });

  it("wait_for_job_returns_null_when_aborted", async () => {
    const registry = createRegistry();
    const controller = new AbortController();
    controller.abort();

    await expect(
      registry.waitForJob({ jobId: "job-1", timeoutMs: 100, signal: controller.signal }),
    ).resolves.toBeNull();
  });

  it("cancel_creates_single_terminal_snapshot", () => {
    const now = vi.fn(() => 1_000);
    const registry = createRegistry(now);
    const job = registry.create(createJob());

    now.mockReturnValueOnce(1_100);
    registry.updateStatus(job.id, "running");
    now.mockReturnValueOnce(1_200);
    const snapshot = registry.cancel(job.id, "manual-cancel");

    expect(snapshot).toEqual({
      id: job.id,
      status: "cancelled",
      startedAt: 1_100,
      finishedAt: 1_200,
      resultSummary: undefined,
      error: "manual-cancel",
      ts: 1_200,
    });
    expect(registry.get(job.id)).toBeNull();
    expect(registry.cancel(job.id, "ignored")).toEqual(snapshot);
  });

  it("prunes_completed_snapshots_after_ttl", () => {
    const now = vi.fn(() => 1_000);
    const registry = createRegistry(now);
    const job = registry.create(createJob());

    registry.updateStatus(job.id, "running", { startedAt: 1_010 });
    registry.updateStatus(job.id, "completed", { finishedAt: 1_020, resultSummary: "done" });
    registry.complete(job.id, {
      id: job.id,
      status: "completed",
      startedAt: 1_010,
      finishedAt: 1_020,
      resultSummary: "done",
      ts: 1_020,
    });

    registry.pruneSnapshots(1_119);
    expect(registry.listEvents(job.id)).not.toHaveLength(0);

    registry.pruneSnapshots(1_120);
    expect(registry.listEvents(job.id)).toEqual([]);
  });
});

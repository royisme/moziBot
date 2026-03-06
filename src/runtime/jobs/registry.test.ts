import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "../../logger";
import { InMemoryAgentJobRegistry } from "./registry";

function createRegistry(now = vi.fn(() => 1_000)) {
  return new InMemoryAgentJobRegistry({ snapshotTtlMs: 100, now });
}

function createJob(id = "job-1") {
  return {
    id,
    sessionKey: "agent:mozi:telegram:dm:user-1",
    agentId: "mozi",
    route: {
      channelId: "telegram",
      peerId: "user-1",
      peerType: "dm" as const,
    },
    source: "reminder" as const,
    kind: "scheduled" as const,
    prompt: "ping",
  };
}

function createLegacyJob(id = "legacy-job-1") {
  return {
    id,
    sessionKey: "agent:mozi:telegram:group:chat-1",
    agentId: "mozi",
    channelId: "telegram",
    peerId: "chat-1",
    peerType: "group" as const,
    threadId: 42,
    replyToId: 101,
    source: "tool" as const,
    kind: "followup" as const,
    prompt: "legacy",
  };
}

function createLegacyJobWithoutPeerType(id = "legacy-job-2") {
  return {
    id,
    sessionKey: "agent:mozi:telegram:group:chat-2",
    agentId: "mozi",
    channelId: "telegram",
    peerId: "chat-2",
    source: "tool" as const,
    kind: "followup" as const,
    prompt: "legacy-no-peer-type",
  };
}

describe("InMemoryAgentJobRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("creates_and_lists_active_jobs", () => {
    const registry = createRegistry();
    const job = registry.create(createJob());

    expect(job.status).toBe("queued");
    expect(registry.get(job.id)?.id).toBe(job.id);
    expect(registry.listActiveBySession(job.sessionKey)).toHaveLength(1);
    expect(registry.listEvents(job.id).map((event) => event.type)).toEqual(["job_queued"]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        sessionKey: job.sessionKey,
        agentId: job.agentId,
        source: job.source,
        kind: job.kind,
        traceId: undefined,
        parentJobId: undefined,
        channelId: job.channelId,
        peerId: job.peerId,
        metadata: undefined,
        lineage: {
          traceId: undefined,
          runId: undefined,
          parentJobId: undefined,
        },
        eventType: "job_queued",
        payload: {
          lifecycle: {
            phase: "job_queued",
            phaseCategory: "queued",
            outcome: "accepted",
            status: undefined,
            startedAt: undefined,
            finishedAt: undefined,
            resultSummary: undefined,
            error: undefined,
            metadata: undefined,
            parentJobId: undefined,
            traceId: undefined,
          },
          tool: undefined,
          delivery: undefined,
          progress: undefined,
          raw: undefined,
        },
      }),
      "AgentJob event",
    );
  });

  it("preserves_peer_type_for_legacy_create_input", () => {
    const registry = createRegistry();
    const job = registry.create(createLegacyJob());

    expect(job.route).toEqual({
      channelId: "telegram",
      peerId: "chat-1",
      peerType: "group",
      threadId: "42",
      replyToId: "101",
    });
    expect(job.peerType).toBe("group");
  });

  it("infers_legacy_peer_type_from_session_key_when_missing", () => {
    const registry = createRegistry();
    const job = registry.create(createLegacyJobWithoutPeerType());

    expect(job.route).toEqual({
      channelId: "telegram",
      peerId: "chat-2",
      peerType: "group",
      threadId: undefined,
      replyToId: undefined,
      accountId: undefined,
    });
    expect(job.peerType).toBe("group");
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

  it("includes metadata and lineage in status event payloads", () => {
    const now = vi.fn(() => 1_000);
    const registry = createRegistry(now);
    const job = registry.create({
      ...createJob(),
      metadata: {
        continuation: {
          reason: "follow-up",
          context: { step: 2 },
          parentMessageId: "msg-1",
          parentQueueItemId: "queue-1",
        },
      },
      parentJobId: "queue-1",
      traceId: "turn:msg-2",
    });

    now.mockReturnValueOnce(1_100);
    registry.updateStatus(job.id, "running");
    now.mockReturnValueOnce(1_200);
    registry.updateStatus(job.id, "completed", { resultSummary: "done" });

    const events = registry.listEvents(job.id);
    expect(events[1]?.payload).toEqual({
      status: "running",
      startedAt: 1_100,
      finishedAt: undefined,
      resultSummary: undefined,
      error: undefined,
      metadata: {
        continuation: {
          reason: "follow-up",
          context: { step: 2 },
          parentMessageId: "msg-1",
          parentQueueItemId: "queue-1",
        },
      },
      parentJobId: "queue-1",
      traceId: "turn:msg-2",
    });
    expect(events[2]?.payload).toEqual({
      status: "completed",
      startedAt: 1_100,
      finishedAt: 1_200,
      resultSummary: "done",
      error: undefined,
      metadata: {
        continuation: {
          reason: "follow-up",
          context: { step: 2 },
          parentMessageId: "msg-1",
          parentQueueItemId: "queue-1",
        },
      },
      parentJobId: "queue-1",
      traceId: "turn:msg-2",
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        sessionKey: job.sessionKey,
        agentId: job.agentId,
        source: job.source,
        kind: job.kind,
        traceId: "turn:msg-2",
        parentJobId: "queue-1",
        channelId: job.channelId,
        peerId: job.peerId,
        metadata: {
          continuation: {
            reason: "follow-up",
            context: { step: 2 },
            parentMessageId: "msg-1",
            parentQueueItemId: "queue-1",
          },
        },
        lineage: {
          traceId: "turn:msg-2",
          runId: undefined,
          parentJobId: "queue-1",
        },
        eventType: "job_started",
        payload: {
          lifecycle: {
            phase: "job_started",
            phaseCategory: "active",
            outcome: "started",
            status: "running",
            startedAt: 1_100,
            finishedAt: undefined,
            resultSummary: undefined,
            error: undefined,
            metadata: {
              continuation: {
                reason: "follow-up",
                context: { step: 2 },
                parentMessageId: "msg-1",
                parentQueueItemId: "queue-1",
              },
            },
            parentJobId: "queue-1",
            traceId: "turn:msg-2",
          },
          tool: undefined,
          delivery: undefined,
          progress: undefined,
          raw: {
            status: "running",
            startedAt: 1_100,
            finishedAt: undefined,
            resultSummary: undefined,
            error: undefined,
            metadata: {
              continuation: {
                reason: "follow-up",
                context: { step: 2 },
                parentMessageId: "msg-1",
                parentQueueItemId: "queue-1",
              },
            },
            parentJobId: "queue-1",
            traceId: "turn:msg-2",
          },
        },
      }),
      "AgentJob event",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        eventType: "job_completed",
      }),
      "AgentJob event",
    );
  });

  it("maps event severity to logger levels", () => {
    const registry = createRegistry();
    const job = registry.create(createJob());

    registry.appendEvent({
      jobId: job.id,
      type: "job_tool_start",
      at: 1_100,
      payload: { toolName: "search" },
    });
    registry.appendEvent({
      jobId: job.id,
      type: "job_waiting",
      at: 1_200,
      payload: { status: "waiting" },
    });
    registry.appendEvent({
      jobId: job.id,
      type: "job_delivery_failed",
      at: 1_300,
      payload: { error: "boom" },
    });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        sessionKey: job.sessionKey,
        agentId: job.agentId,
        source: job.source,
        kind: job.kind,
        channelId: job.channelId,
        peerId: job.peerId,
        lineage: {
          traceId: undefined,
          runId: undefined,
          parentJobId: undefined,
        },
        eventType: "job_tool_start",
        payload: {
          lifecycle: undefined,
          tool: {
            phase: "job_tool_start",
            phaseCategory: "active",
            outcome: "started",
            toolName: "search",
            toolCallId: undefined,
            isError: undefined,
          },
          delivery: undefined,
          progress: undefined,
          raw: { toolName: "search" },
        },
      }),
      "AgentJob event",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        sessionKey: job.sessionKey,
        agentId: job.agentId,
        source: job.source,
        kind: job.kind,
        channelId: job.channelId,
        peerId: job.peerId,
        lineage: {
          traceId: undefined,
          runId: undefined,
          parentJobId: undefined,
        },
        eventType: "job_waiting",
        payload: {
          lifecycle: {
            phase: "job_waiting",
            phaseCategory: "blocked",
            outcome: "waiting",
            status: "waiting",
            startedAt: undefined,
            finishedAt: undefined,
            resultSummary: undefined,
            error: undefined,
            metadata: undefined,
            parentJobId: undefined,
            traceId: undefined,
          },
          tool: undefined,
          delivery: undefined,
          progress: undefined,
          raw: { status: "waiting" },
        },
      }),
      "AgentJob event",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        sessionKey: job.sessionKey,
        agentId: job.agentId,
        source: job.source,
        kind: job.kind,
        channelId: job.channelId,
        peerId: job.peerId,
        lineage: {
          traceId: undefined,
          runId: undefined,
          parentJobId: undefined,
        },
        eventType: "job_delivery_failed",
        payload: {
          lifecycle: undefined,
          tool: undefined,
          delivery: {
            phase: "job_delivery_failed",
            phaseCategory: "delivery",
            outcome: "failed",
            status: undefined,
            attempts: undefined,
            outboundId: undefined,
            error: "boom",
          },
          progress: undefined,
          raw: { error: "boom" },
        },
      }),
      "AgentJob event",
    );
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

import { logger } from "../../logger";
import { normalizeRouteContext } from "../host/routing/route-context";
import type { RouteContext } from "../host/routing/types";
import { createAgentJobEvent } from "./events";
import type {
  AgentJob,
  AgentJobEvent,
  AgentJobRegistry,
  AgentJobSnapshot,
  AgentJobStatus,
  CreateAgentJobInput,
  WaitForAgentJobParams,
} from "./types";

const DEFAULT_EVENT_BUFFER_SIZE = 50;
const DEFAULT_SNAPSHOT_TTL_MS = 10 * 60_000;

const ALLOWED_TRANSITIONS: Readonly<Record<AgentJobStatus, readonly AgentJobStatus[]>> = {
  queued: ["running"],
  running: ["waiting", "completed", "failed", "cancelled"],
  waiting: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

type Waiter = (snapshot: AgentJobSnapshot | null) => void;

export interface InMemoryAgentJobRegistryOptions {
  readonly snapshotTtlMs?: number;
  readonly eventBufferSize?: number;
  readonly now?: () => number;
}

/** In-memory AgentJob registry with waiter and snapshot caching support. */
export class InMemoryAgentJobRegistry implements AgentJobRegistry {
  private readonly activeJobs = new Map<string, AgentJob>();
  private readonly completedSnapshots = new Map<string, AgentJobSnapshot>();
  private readonly snapshotExpiresAt = new Map<string, number>();
  private readonly jobWaiters = new Map<string, Set<Waiter>>();
  private readonly jobEvents = new Map<string, AgentJobEvent[]>();
  private readonly jobLogContext = new Map<string, Record<string, unknown>>();
  private readonly snapshotTtlMs: number;
  private readonly eventBufferSize: number;
  private readonly now: () => number;

  constructor(options: InMemoryAgentJobRegistryOptions = {}) {
    this.snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    this.eventBufferSize = options.eventBufferSize ?? DEFAULT_EVENT_BUFFER_SIZE;
    this.now = options.now ?? Date.now;
  }

  create(job: CreateAgentJobInput): AgentJob {
    if (this.activeJobs.has(job.id) || this.completedSnapshots.has(job.id)) {
      throw new Error(`Agent job already exists: ${job.id}`);
    }

    const route = resolveJobRoute(job);
    const entry: AgentJob = {
      id: job.id,
      sessionKey: job.sessionKey,
      agentId: job.agentId,
      route,
      channelId: route.channelId,
      peerId: route.peerId,
      peerType: route.peerType,
      accountId: route.accountId,
      threadId: route.threadId,
      replyToId: route.replyToId,
      source: job.source,
      kind: job.kind,
      prompt: job.prompt,
      metadata: job.metadata,
      status: "queued",
      createdAt: job.createdAt ?? this.now(),
      parentJobId: job.parentJobId,
      traceId: job.traceId,
    };

    this.activeJobs.set(entry.id, entry);
    this.jobLogContext.set(entry.id, buildJobLogContext(entry));
    this.appendEvent(
      createAgentJobEvent({ jobId: entry.id, type: "job_queued", at: entry.createdAt }),
    );
    return entry;
  }

  get(jobId: string): AgentJob | null {
    return this.activeJobs.get(jobId) ?? null;
  }

  listActiveBySession(sessionKey: string): AgentJob[] {
    return [...this.activeJobs.values()].filter((job) => job.sessionKey === sessionKey);
  }

  appendEvent(event: AgentJobEvent): void {
    this.logEvent(event);
    const events = this.jobEvents.get(event.jobId) ?? [];
    events.push(event);
    if (events.length > this.eventBufferSize) {
      events.splice(0, events.length - this.eventBufferSize);
    }
    this.jobEvents.set(event.jobId, events);
  }

  listEvents(jobId: string): AgentJobEvent[] {
    return [...(this.jobEvents.get(jobId) ?? [])];
  }

  updateStatus(jobId: string, nextStatus: AgentJobStatus, patch: Partial<AgentJob> = {}): AgentJob {
    const current = this.activeJobs.get(jobId);
    if (!current) {
      throw new Error(`Active agent job not found: ${jobId}`);
    }

    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(`Illegal AgentJob transition: ${current.status} -> ${nextStatus}`);
    }

    const now = this.now();
    const updated: AgentJob = {
      ...current,
      ...patch,
      status: nextStatus,
      startedAt:
        nextStatus === "running"
          ? (patch.startedAt ?? current.startedAt ?? now)
          : (patch.startedAt ?? current.startedAt),
      finishedAt:
        nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled"
          ? (patch.finishedAt ?? current.finishedAt ?? now)
          : (patch.finishedAt ?? current.finishedAt),
    };

    this.activeJobs.set(jobId, updated);
    this.jobLogContext.set(jobId, buildJobLogContext(updated));
    this.appendEvent(
      createAgentJobEvent({
        jobId,
        type: mapStatusToEvent(nextStatus),
        at: now,
        payload: buildStatusPayload(updated),
      }),
    );
    return updated;
  }

  complete(jobId: string, snapshot: AgentJobSnapshot): AgentJobSnapshot {
    const current = this.activeJobs.get(jobId);
    if (!current) {
      throw new Error(`Active agent job not found: ${jobId}`);
    }
    if (snapshot.id !== jobId) {
      throw new Error(`Snapshot/job id mismatch: ${snapshot.id} !== ${jobId}`);
    }

    this.activeJobs.delete(jobId);
    this.completedSnapshots.set(jobId, snapshot);
    this.snapshotExpiresAt.set(jobId, (snapshot.ts ?? this.now()) + this.snapshotTtlMs);
    this.resolveWaiters(jobId, snapshot);
    return snapshot;
  }

  cancel(jobId: string, reason?: string): AgentJobSnapshot | null {
    const current = this.activeJobs.get(jobId);
    if (!current) {
      return this.completedSnapshots.get(jobId) ?? null;
    }

    const updated = this.updateStatus(jobId, "cancelled", {
      error: reason ?? current.error,
    });
    return this.complete(jobId, {
      id: jobId,
      status: "cancelled",
      startedAt: updated.startedAt,
      finishedAt: updated.finishedAt,
      resultSummary: updated.resultSummary,
      error: updated.error,
      ts: updated.finishedAt ?? this.now(),
    });
  }

  waitForJob(params: WaitForAgentJobParams): Promise<AgentJobSnapshot | null> {
    const existing = this.completedSnapshots.get(params.jobId);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise<AgentJobSnapshot | null>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;

      const settle = (snapshot: AgentJobSnapshot | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (abortHandler) {
          params.signal?.removeEventListener("abort", abortHandler);
        }
        this.removeWaiter(params.jobId, waiter);
        resolve(snapshot);
      };

      const waiter: Waiter = (snapshot) => settle(snapshot);
      const waiters = this.jobWaiters.get(params.jobId) ?? new Set<Waiter>();
      waiters.add(waiter);
      this.jobWaiters.set(params.jobId, waiters);

      if (params.timeoutMs !== undefined) {
        timeoutId = setTimeout(() => settle(null), params.timeoutMs);
      }

      if (params.signal) {
        if (params.signal.aborted) {
          settle(null);
          return;
        }
        abortHandler = () => settle(null);
        params.signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }

  pruneSnapshots(now = this.now()): void {
    for (const [jobId, expiresAt] of this.snapshotExpiresAt.entries()) {
      if (expiresAt > now) {
        continue;
      }
      this.snapshotExpiresAt.delete(jobId);
      this.completedSnapshots.delete(jobId);
      this.jobEvents.delete(jobId);
      this.jobLogContext.delete(jobId);
    }
  }

  private removeWaiter(jobId: string, waiter: Waiter): void {
    const waiters = this.jobWaiters.get(jobId);
    if (!waiters) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.jobWaiters.delete(jobId);
    }
  }

  private resolveWaiters(jobId: string, snapshot: AgentJobSnapshot): void {
    const waiters = this.jobWaiters.get(jobId);
    if (!waiters) {
      return;
    }
    this.jobWaiters.delete(jobId);
    for (const waiter of waiters) {
      waiter(snapshot);
    }
  }

  private logEvent(event: AgentJobEvent): void {
    const base = {
      ...this.jobLogContext.get(event.jobId),
      jobId: event.jobId,
      runId: event.runId,
      lineage: buildLineagePayload({
        ...this.jobLogContext.get(event.jobId),
        runId: event.runId,
      }),
      eventType: event.type,
      eventAt: event.at,
      payload: buildLogPayload(event),
    };

    switch (event.type) {
      case "job_failed":
      case "job_delivery_failed":
        logger.error(base, "AgentJob event");
        return;
      case "job_cancelled":
      case "job_waiting":
        logger.warn(base, "AgentJob event");
        return;
      case "job_tool_start":
      case "job_tool_end":
      case "job_progress":
      case "job_delivery_requested":
      case "job_delivery_succeeded":
        logger.debug(base, "AgentJob event");
        return;
      case "job_queued":
      case "job_started":
      case "job_completed":
        logger.info(base, "AgentJob event");
        return;
    }
  }
}

function buildJobLogContext(job: AgentJob): Record<string, unknown> {
  return {
    sessionKey: job.sessionKey,
    agentId: job.agentId,
    source: job.source,
    kind: job.kind,
    traceId: job.traceId,
    parentJobId: job.parentJobId,
    channelId: job.route.channelId,
    peerId: job.route.peerId,
    accountId: job.route.accountId,
    threadId: job.route.threadId,
    metadata: job.metadata,
  };
}

function buildLineagePayload(input: {
  traceId?: unknown;
  runId?: unknown;
  parentJobId?: unknown;
}): Record<string, unknown> {
  return {
    traceId: input.traceId,
    runId: input.runId,
    parentJobId: input.parentJobId,
  };
}

function resolveJobRoute(job: CreateAgentJobInput): RouteContext {
  if (job.route) {
    return normalizeRouteContext({
      channelId: job.route.channelId,
      peerId: job.route.peerId,
      peerType: job.route.peerType,
      accountId: job.route.accountId,
      threadId: job.route.threadId,
      replyToId: job.route.replyToId,
    });
  }

  if (!job.channelId || !job.peerId) {
    throw new Error("CreateAgentJobInput requires route or channelId/peerId");
  }

  return normalizeRouteContext({
    channelId: job.channelId,
    peerId: job.peerId,
    peerType: job.peerType ?? inferLegacyPeerType(job.sessionKey) ?? "dm",
    accountId: job.accountId,
    threadId: job.threadId,
    replyToId: job.replyToId,
  });
}

function inferLegacyPeerType(sessionKey: string): RouteContext["peerType"] | undefined {
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent") {
    return undefined;
  }

  const scopedPeerType = parts[3];
  if (scopedPeerType === "group" || scopedPeerType === "channel") {
    return scopedPeerType;
  }

  if (parts[2] === "dm" || parts[3] === "dm" || parts[4] === "dm") {
    return "dm";
  }

  return undefined;
}

function mapStatusToEvent(status: AgentJobStatus): AgentJobEvent["type"] {
  switch (status) {
    case "queued":
      return "job_queued";
    case "running":
      return "job_started";
    case "waiting":
      return "job_waiting";
    case "completed":
      return "job_completed";
    case "failed":
      return "job_failed";
    case "cancelled":
      return "job_cancelled";
  }
}

function buildStatusPayload(job: AgentJob): Record<string, unknown> {
  return {
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    resultSummary: job.resultSummary,
    error: job.error,
    metadata: job.metadata,
    parentJobId: job.parentJobId,
    traceId: job.traceId,
    accountId: job.route.accountId,
    threadId: job.route.threadId,
  };
}

function buildLogPayload(event: AgentJobEvent): Record<string, unknown> {
  return {
    lifecycle: buildLifecyclePayload(event),
    tool: buildToolPayload(event),
    delivery: buildDeliveryPayload(event),
    progress: buildProgressPayload(event),
    raw: event.payload,
  };
}

function buildLifecyclePayload(event: AgentJobEvent): Record<string, unknown> | undefined {
  if (
    event.type !== "job_queued" &&
    event.type !== "job_started" &&
    event.type !== "job_waiting" &&
    event.type !== "job_completed" &&
    event.type !== "job_failed" &&
    event.type !== "job_cancelled"
  ) {
    return undefined;
  }

  return {
    phase: event.type,
    phaseCategory: resolvePhaseCategory(event.type),
    outcome: resolveOutcome(event.type),
    status: event.payload?.status,
    startedAt: event.payload?.startedAt,
    finishedAt: event.payload?.finishedAt,
    resultSummary: event.payload?.resultSummary,
    error: event.payload?.error,
    metadata: event.payload?.metadata,
    parentJobId: event.payload?.parentJobId,
    traceId: event.payload?.traceId,
  };
}

function buildToolPayload(event: AgentJobEvent): Record<string, unknown> | undefined {
  if (event.type !== "job_tool_start" && event.type !== "job_tool_end") {
    return undefined;
  }

  return {
    phase: event.type,
    phaseCategory: "active",
    outcome:
      event.type === "job_tool_end" ? (event.payload?.isError ? "failed" : "completed") : "started",
    toolName: event.payload?.toolName,
    toolCallId: event.payload?.toolCallId,
    isError: event.payload?.isError,
  };
}

function buildDeliveryPayload(event: AgentJobEvent): Record<string, unknown> | undefined {
  if (
    event.type !== "job_delivery_requested" &&
    event.type !== "job_delivery_succeeded" &&
    event.type !== "job_delivery_failed"
  ) {
    return undefined;
  }

  return {
    phase: event.type,
    phaseCategory: "delivery",
    outcome:
      event.type === "job_delivery_requested"
        ? "requested"
        : event.type === "job_delivery_succeeded"
          ? "completed"
          : "failed",
    status: event.payload?.status,
    attempts: event.payload?.attempts,
    outboundId: event.payload?.outboundId,
    error: event.payload?.error,
  };
}

function buildProgressPayload(event: AgentJobEvent): Record<string, unknown> | undefined {
  if (event.type !== "job_progress") {
    return undefined;
  }

  return {
    phase: event.type,
    phaseCategory: "active",
    outcome: "streaming",
    delta: event.payload?.delta,
  };
}

function resolvePhaseCategory(
  eventType: AgentJobEvent["type"],
): "queued" | "active" | "blocked" | "terminal" | "delivery" {
  switch (eventType) {
    case "job_queued":
      return "queued";
    case "job_started":
      return "active";
    case "job_waiting":
      return "blocked";
    case "job_completed":
    case "job_failed":
    case "job_cancelled":
      return "terminal";
    case "job_delivery_requested":
    case "job_delivery_succeeded":
    case "job_delivery_failed":
      return "delivery";
    case "job_progress":
    case "job_tool_start":
    case "job_tool_end":
      return "active";
  }
}

function resolveOutcome(eventType: AgentJobEvent["type"]): string | undefined {
  switch (eventType) {
    case "job_queued":
      return "accepted";
    case "job_started":
      return "started";
    case "job_waiting":
      return "waiting";
    case "job_completed":
      return "completed";
    case "job_failed":
      return "failed";
    case "job_cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

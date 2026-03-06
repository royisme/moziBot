import type { RouteContext } from "../host/routing/types";

export type AgentJobStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentJobTerminalStatus = Extract<AgentJobStatus, "completed" | "failed" | "cancelled">;

export type AgentJobSource = "inbound" | "reminder" | "tool" | "api" | "system";

export type AgentJobKind = "followup" | "background" | "scheduled" | "tool_wait";

export interface AgentJob {
  readonly id: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly route: RouteContext;
  readonly channelId?: string;
  readonly peerId?: string;
  readonly peerType?: RouteContext["peerType"];
  readonly accountId?: string;
  readonly threadId?: string;
  readonly replyToId?: string;
  readonly source: AgentJobSource;
  readonly kind: AgentJobKind;
  readonly prompt: string;
  readonly metadata?: Record<string, unknown>;
  status: AgentJobStatus;
  readonly createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  parentJobId?: string;
  traceId?: string;
  resultSummary?: string;
  error?: string;
}

export interface CreateAgentJobInput {
  readonly id: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly route?: RouteContext;
  readonly channelId?: string;
  readonly peerId?: string;
  readonly peerType?: RouteContext["peerType"];
  readonly accountId?: string;
  readonly threadId?: string | number;
  readonly replyToId?: string | number;
  readonly source: AgentJobSource;
  readonly kind: AgentJobKind;
  readonly prompt: string;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt?: number;
  readonly parentJobId?: string;
  readonly traceId?: string;
}

export interface AgentJobSnapshot {
  readonly id: string;
  readonly status: AgentJobTerminalStatus;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly resultSummary?: string;
  readonly error?: string;
  readonly ts: number;
}

export type AgentJobEventType =
  | "job_queued"
  | "job_started"
  | "job_waiting"
  | "job_progress"
  | "job_tool_start"
  | "job_tool_end"
  | "job_completed"
  | "job_failed"
  | "job_cancelled"
  | "job_delivery_requested"
  | "job_delivery_succeeded"
  | "job_delivery_failed";

export interface AgentJobEvent {
  readonly jobId: string;
  readonly runId?: string;
  readonly type: AgentJobEventType;
  readonly at: number;
  readonly payload?: Record<string, unknown>;
}

export interface WaitForAgentJobParams {
  readonly jobId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AgentJobRegistry {
  create(job: CreateAgentJobInput): AgentJob;
  get(jobId: string): AgentJob | null;
  listActiveBySession(sessionKey: string): AgentJob[];
  appendEvent(event: AgentJobEvent): void;
  listEvents(jobId: string): AgentJobEvent[];
  updateStatus(jobId: string, nextStatus: AgentJobStatus, patch?: Partial<AgentJob>): AgentJob;
  complete(jobId: string, snapshot: AgentJobSnapshot): AgentJobSnapshot;
  cancel(jobId: string, reason?: string): AgentJobSnapshot | null;
  waitForJob(params: WaitForAgentJobParams): Promise<AgentJobSnapshot | null>;
  pruneSnapshots(now?: number): void;
}

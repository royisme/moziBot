import type {
  InboundMessage,
  OutboundMessage,
  StatusReaction,
  StatusReactionPayload,
} from "../adapters/channels/types";

export type RuntimeQueueStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "interrupted";

export type RuntimeQueueMode = "followup" | "collect" | "interrupt" | "steer" | "steer-backlog";

export interface RuntimeQueueConfig {
  mode?: RuntimeQueueMode;
  collectWindowMs?: number;
  maxBacklog?: number;
}

export interface RuntimeInboundEnvelope {
  id: string;
  inbound: InboundMessage;
  dedupKey?: string;
  receivedAt: Date;
}

export interface RuntimeEnqueueResult {
  accepted: boolean;
  deduplicated: boolean;
  queueItemId: string;
  sessionKey: string;
}

export interface RuntimeDeliveryReceipt {
  queueItemId: string;
  envelopeId: string;
  sessionKey: string;
  channelId: string;
  peerId: string;
  attempt: number;
  status: RuntimeQueueStatus;
}

export interface RuntimeIngress {
  enqueueInbound(envelope: RuntimeInboundEnvelope): Promise<RuntimeEnqueueResult>;
}

export interface RuntimeEgress {
  deliver(outbound: OutboundMessage, receipt: RuntimeDeliveryReceipt): Promise<string>;
  beginTyping?(receipt: RuntimeDeliveryReceipt): Promise<(() => Promise<void> | void) | void>;
  setStatusReaction?(params: {
    receipt: RuntimeDeliveryReceipt;
    messageId: string;
    status: StatusReaction;
    payload?: StatusReactionPayload;
  }): Promise<void>;
}

export interface RuntimeErrorDecision {
  retry: boolean;
  delayMs: number;
  reason: string;
}

export interface RuntimeErrorPolicy {
  decide(error: Error, attempt: number): RuntimeErrorDecision;
}

/**
 * Request from an agent to schedule a follow-up task for itself.
 * This enables autonomous multi-step workflows where the agent can
 * continue working after the current response.
 */
export interface ContinuationRequest {
  /** The prompt/instruction for the follow-up task */
  prompt: string;
  /** Optional delay in milliseconds before the continuation runs */
  delayMs?: number;
  /** Reason for the continuation (for logging/debugging) */
  reason?: string;
  /** Optional context to pass to the continuation */
  context?: Record<string, unknown>;
}

/**
 * Result returned by MessageHandler.handle() to signal continuation needs.
 */
export interface HandleResult {
  /** If set, the kernel will enqueue a follow-up task */
  continuation?: ContinuationRequest;
}

// ---------------------------------------------------------------------------
// Unified Event Queue types
// ---------------------------------------------------------------------------

export type EventType =
  | "user_message"
  | "subagent_result"
  | "internal"
  | "cron_fire"
  | "reminder"
  | "watchdog_wake";

export interface EventEnqueuer {
  enqueueEvent(params: {
    sessionKey: string;
    eventType: EventType;
    payload: Record<string, unknown>;
    priority?: number;
    scheduledAt?: Date;
  }): Promise<void>;
}

export type SubagentResultPayload = {
  parentSessionKey: string;
  parentAgentId: string;
  runId: string;
  childSessionKey: string;
  terminal: "completed" | "timeout" | "aborted" | "failed";
  resultText?: string;
  error?: string;
  visibilityPolicy: "user_visible" | "internal_silent";
};

/** Default priority for each event type. Lower number = higher priority. */
export const EVENT_PRIORITY = {
  user_message: 0,
  subagent_result: 1,
  internal: 2,
  cron_fire: 5,
  reminder: 5,
  watchdog_wake: 10,
} as const satisfies Record<EventType, number>;

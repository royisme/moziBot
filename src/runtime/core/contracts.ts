import type { InboundMessage, OutboundMessage } from "../adapters/channels/types";

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

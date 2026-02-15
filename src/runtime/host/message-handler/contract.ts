import type { MoziConfig } from "../../../config";
import type { DeliveryPlan } from "../../../multimodal/capabilities";
import type { OutboundMessage } from "../../adapters/channels/types";
import type { CommandHandlerMap } from "./services/command-handlers";
import type { InteractionPhase, PhasePayload } from "./services/interaction-lifecycle";
import type { StreamingCallback, StreamingBuffer } from "./services/streaming";
import type { FallbackInfo } from "./services/prompt-runner";
import type { ReplyRenderOptions } from "./render/reasoning";
import type { AssistantMessageShape } from "./services/reply-finalizer";
import type { SessionTimestamps } from "./lifecycle/temporal";

/**
 * Canonical contracts for message-handler turn orchestration
 * Strict typing only, no 'any'.
 */

export type FlowResult = 'continue' | 'handled' | 'abort';

export interface MessageTurnContext {
  readonly messageId: string;
  readonly traceId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly startTime: number;
  readonly state: Record<string, unknown>;
}

export interface PreparedPromptBundle {
  readonly promptId: string;
  readonly agentId: string;
  readonly config: Record<string, unknown>;
}

export interface CleanupBundle {
  readonly correlationId: string;
  readonly finalStatus: string;
}

/**
 * Dependency bridge contract for the Orchestrator.
 * Defines all strictly-typed callbacks required by flow modules.
 */
export interface OrchestratorDeps {
  readonly config: MoziConfig;
  readonly logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
  
  // Inbound & Command Helpers
  getText(payload: unknown): string;
  getMedia(payload: unknown): unknown[];
  normalizeImplicitControlCommand(text: string): string;
  parseCommand(text: string): { name: string; args: string } | null;
  parseInlineOverrides(parsedCommand: { name: string; args: string } | null): {
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    reasoningLevel?: "off" | "on" | "stream";
    promptText: string;
  } | null;
  resolveSessionContext(payload: unknown): { 
    agentId: string; 
    sessionKey: string; 
    peerId: string; 
    dmScope?: string 
  };
  rememberLastRoute(agentId: string, payload: unknown): void;
  sendDirect(peerId: string, text: string): Promise<void>;
  getCommandHandlerMap(): CommandHandlerMap;
  getChannel(payload: unknown): ChannelDispatcherBridge;

  // Lifecycle Helpers
  resetSession(sessionKey: string, agentId: string): void;
  getSessionTimestamps(sessionKey: string): SessionTimestamps;
  getSessionMetadata(sessionKey: string): Record<string, unknown>;
  updateSessionMetadata(sessionKey: string, meta: Record<string, unknown>): void;
  revertToPreviousSegment(sessionKey: string, agentId: string): boolean;
  getConfigAgents(): Record<string, unknown>;
  getSessionMessages(sessionKey: string): AssistantMessageShape[];

  // Prompt & Execution Helpers
  transcribeInboundMessage(payload: unknown): Promise<string | undefined>;
  checkInputCapability(params: {
    sessionKey: string;
    agentId: string;
    message: unknown;
    peerId: string;
    hasAudioTranscript: boolean;
  }): Promise<{ ok: boolean; restoreModelRef?: string }>;
  ingestInboundMessage(params: {
    message: unknown;
    sessionKey: string;
    agentId: string;
  }): Promise<unknown>;
  buildPromptText(params: {
    message: unknown;
    rawText: string;
    transcript?: string;
    ingestPlan: unknown;
  }): string;
  ensureChannelContext(params: {
    sessionKey: string;
    agentId: string;
    message: unknown;
  }): Promise<void>;
  startTypingIndicator(params: {
    sessionKey: string;
    agentId: string;
    peerId: string;
  }): Promise<(() => Promise<void> | void) | undefined>;
  emitPhaseSafely(params: {
    phase: InteractionPhase;
    payload: PhasePayload;
  }): Promise<void>;
  createStreamingBuffer(params: {
    peerId: string;
    onError: (err: Error) => void;
    traceId?: string;
  }): StreamingBuffer;
  runPromptWithFallback(params: {
    sessionKey: string;
    agentId: string;
    text: string;
    traceId?: string;
    onStream?: StreamingCallback;
    onFallback?: (info: FallbackInfo) => Promise<void>;
  }): Promise<void>;
  maybePreFlushBeforePrompt(params: {
    sessionKey: string;
    agentId: string;
  }): Promise<void>;
  resolveReplyRenderOptions(agentId: string): ReplyRenderOptions;
  resolveLastAssistantReplyText(params: {
    messages: AssistantMessageShape[];
    renderOptions: ReplyRenderOptions;
  }): string | undefined;
  shouldSuppressSilentReply(text: string | undefined): boolean;
  shouldSuppressHeartbeatReply(raw: unknown, text: string): boolean;
  finalizeStreamingReply(params: {
    buffer: StreamingBuffer;
    replyText?: string;
  }): Promise<string | null>;
  buildNegotiatedOutbound(params: {
    channelId: string;
    replyText?: string;
    inboundPlan: DeliveryPlan | null;
  }): OutboundMessage;
  sendNegotiatedReply(params: {
    peerId: string;
    outbound: OutboundMessage;
  }): Promise<string>;
  
  // Error Helpers
  toError(err: unknown): Error;
  isAbortError(err: Error): boolean;
  createErrorReplyText(err: Error): string;
  setSessionModel(sessionKey: string, modelRef: string): Promise<void>;
  stopTypingIndicator(params: {
    stop?: () => Promise<void> | void;
    sessionKey: string;
    agentId: string;
    peerId: string;
  }): Promise<void>;
}

export interface ChannelDispatcherBridge {
  readonly id: string;
  readonly editMessage?: (messageId: string, peerId: string, text: string) => Promise<void>;
  readonly send: (peerId: string, message: OutboundMessage) => Promise<string>;
}

// Flow Function Aliases
export type InboundFlow = (ctx: MessageTurnContext, deps: OrchestratorDeps) => Promise<FlowResult>;
export type CommandFlow = (ctx: MessageTurnContext, deps: OrchestratorDeps) => Promise<FlowResult>;
export type LifecycleFlow = (ctx: MessageTurnContext, deps: OrchestratorDeps) => Promise<FlowResult>;
export type PromptFlow = (ctx: MessageTurnContext, deps: OrchestratorDeps) => Promise<FlowResult | PreparedPromptBundle>;
export type ExecutionFlow = (ctx: MessageTurnContext, deps: OrchestratorDeps, bundle: PreparedPromptBundle) => Promise<FlowResult>;
export type ErrorFlow = (ctx: MessageTurnContext, deps: OrchestratorDeps, error: unknown) => Promise<FlowResult>;
export type CleanupFlow = (ctx: MessageTurnContext, deps: OrchestratorDeps, bundle: CleanupBundle) => Promise<void>;

export interface MessageTurnHandler {
  handle(ctx: MessageTurnContext): Promise<unknown>;
}

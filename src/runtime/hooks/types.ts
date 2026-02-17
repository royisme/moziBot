import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type RuntimeHookName =
  | "before_agent_start"
  | "before_tool_call"
  | "after_tool_call"
  | "before_reset"
  | "turn_completed";

export type RuntimeObserverHookName = "after_tool_call" | "before_reset" | "turn_completed";
export type RuntimeInterceptorHookName = "before_agent_start" | "before_tool_call";

export type RuntimeHookBaseContext = {
  sessionKey?: string;
  agentId?: string;
};

export type BeforeAgentStartEvent = {
  promptText: string;
  ingestPlan?: unknown;
};

export type BeforeAgentStartContext = RuntimeHookBaseContext & {
  traceId?: string;
  messageId?: string;
};

export type BeforeAgentStartResult = {
  promptText?: string;
  block?: boolean;
  blockReason?: string;
};

export type BeforeToolCallEvent = {
  toolName: string;
  args: Record<string, unknown>;
};

export type BeforeToolCallContext = RuntimeHookBaseContext;

export type BeforeToolCallResult = {
  args?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
};

export type AfterToolCallEvent = {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

export type AfterToolCallContext = RuntimeHookBaseContext;

export type BeforeResetEvent = {
  reason: string;
  messages?: AgentMessage[];
};

export type BeforeResetContext = RuntimeHookBaseContext;

export type TurnCompletedEvent = {
  traceId: string;
  messageId: string;
  status: "success" | "interrupted";
  durationMs: number;
  userText?: string;
  replyText?: string;
};

export type TurnCompletedContext = RuntimeHookBaseContext;

export type RuntimeHookHandlerMap = {
  before_agent_start: (
    event: BeforeAgentStartEvent,
    ctx: BeforeAgentStartContext,
  ) => Promise<BeforeAgentStartResult | void> | BeforeAgentStartResult | void;
  before_tool_call: (
    event: BeforeToolCallEvent,
    ctx: BeforeToolCallContext,
  ) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void;
  after_tool_call: (event: AfterToolCallEvent, ctx: AfterToolCallContext) => Promise<void> | void;
  before_reset: (event: BeforeResetEvent, ctx: BeforeResetContext) => Promise<void> | void;
  turn_completed: (event: TurnCompletedEvent, ctx: TurnCompletedContext) => Promise<void> | void;
};

export type RuntimeHookRegistration<K extends RuntimeHookName = RuntimeHookName> = {
  id: string;
  hookName: K;
  handler: RuntimeHookHandlerMap[K];
  priority?: number;
};

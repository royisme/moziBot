import { EventEmitter } from "events";

export type AgentEventStream = "lifecycle" | "tool" | "assistant";

export interface AgentLifecycleEvent {
  stream: "lifecycle";
  runId: string;
  sessionKey: string;
  data: {
    phase: "start" | "end" | "error";
    startedAt?: number;
    endedAt?: number;
    error?: string;
  };
}

export interface AgentToolEvent {
  stream: "tool";
  runId: string;
  sessionKey: string;
  data: {
    toolName: string;
    status: "called" | "completed" | "error";
    result?: unknown;
  };
}

export type AgentEvent = AgentLifecycleEvent | AgentToolEvent;

class AgentEventEmitter extends EventEmitter {
  private static instance: AgentEventEmitter;

  static getInstance(): AgentEventEmitter {
    if (!AgentEventEmitter.instance) {
      AgentEventEmitter.instance = new AgentEventEmitter();
    }
    return AgentEventEmitter.instance;
  }

  emitLifecycle(event: Omit<AgentLifecycleEvent, "stream">): void {
    this.emit("agent-event", { ...event, stream: "lifecycle" } as AgentLifecycleEvent);
  }

  emitTool(event: Omit<AgentToolEvent, "stream">): void {
    this.emit("agent-event", { ...event, stream: "tool" } as AgentToolEvent);
  }
}

export const agentEvents = AgentEventEmitter.getInstance();

export function onAgentEvent(handler: (event: AgentEvent) => void): () => void {
  agentEvents.on("agent-event", handler);
  return () => agentEvents.off("agent-event", handler);
}

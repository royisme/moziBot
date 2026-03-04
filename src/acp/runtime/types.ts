export type AcpRuntimePromptMode = "prompt" | "steer";

export type AcpRuntimeSessionMode = "persistent" | "oneshot";

export type AcpRuntimeControl = "session/set_mode" | "session/set_config_option" | "session/status";

/**
 * Terminal event types that signal the end of a turn.
 * Exactly one terminal event MUST be emitted per turn.
 */
export type AcpRuntimeTerminalEventType = "done" | "error";

/**
 * Non-terminal event types that can appear during a turn.
 */
export type AcpRuntimeNonTerminalEventType = "text_delta" | "status" | "tool_call" | "started";

export type AcpRuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  /** Effective runtime working directory for this ACP session, if exposed by adapter/runtime. */
  cwd?: string;
  /** Backend-local record identifier, if exposed by adapter/runtime (for example acpx record id). */
  acpxRecordId?: string;
  /** Backend-level ACP session identifier, if exposed by adapter/runtime. */
  backendSessionId?: string;
  /** Upstream harness session identifier, if exposed by adapter/runtime. */
  agentSessionId?: string;
};

export type AcpRuntimeEnsureInput = {
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  cwd?: string;
  env?: Record<string, string>;
};

export type AcpRuntimeTurnInput = {
  handle: AcpRuntimeHandle;
  text: string;
  mode: AcpRuntimePromptMode;
  requestId: string;
  signal?: AbortSignal;
};

export type AcpRuntimeCapabilities = {
  controls: AcpRuntimeControl[];
  /**
   * Optional backend-advertised option keys for session/set_config_option.
   * Empty/undefined means "backend accepts keys, but did not advertise a strict list".
   */
  configOptionKeys?: string[];
};

export type AcpRuntimeStatus = {
  summary?: string;
  /** Backend-local record identifier, if exposed by adapter/runtime. */
  acpxRecordId?: string;
  /** Backend-level ACP session identifier, if known at status time. */
  backendSessionId?: string;
  /** Upstream harness session identifier, if known at status time. */
  agentSessionId?: string;
  details?: Record<string, unknown>;
};

export type AcpRuntimeDoctorReport = {
  ok: boolean;
  code?: string;
  message: string;
  installCommand?: string;
  details?: string[];
};

/**
 * Base interface for all runtime events.
 */
export type AcpRuntimeEventBase = {
  /** Timestamp when the event was generated (milliseconds since epoch) */
  timestamp?: number;
};

/**
 * Event emitted when a turn starts.
 * This is always the first event in the stream.
 */
export type AcpRuntimeStartedEvent = AcpRuntimeEventBase & {
  type: "started";
  requestId: string;
};

/**
 * Event for text deltas (streaming output).
 */
export type AcpRuntimeTextDeltaEvent = AcpRuntimeEventBase & {
  type: "text_delta";
  text: string;
  stream?: "output" | "thought";
};

/**
 * Event for status updates during processing.
 */
export type AcpRuntimeStatusEvent = AcpRuntimeEventBase & {
  type: "status";
  text: string;
};

/**
 * Event for tool calls.
 */
export type AcpRuntimeToolCallEvent = AcpRuntimeEventBase & {
  type: "tool_call";
  text: string;
};

/**
 * Terminal event indicating successful completion.
 * Exactly one of done|error MUST be emitted per turn.
 */
export type AcpRuntimeDoneEvent = AcpRuntimeEventBase & {
  type: "done";
  stopReason?: string;
};

/**
 * Error classification categories for runtime errors.
 */
export type AcpRuntimeErrorCategory =
  | "config" // Configuration-related errors (invalid options, missing config)
  | "policy" // Policy violations (dispatch disabled, agent not allowed)
  | "runtime" // Runtime execution errors (backend unavailable, turn failed)
  | "network" // Network/communication errors
  | "cancelled"; // User-initiated cancellation

/**
 * Terminal event indicating error completion.
 * Exactly one of done|error MUST be emitted per turn.
 */
export type AcpRuntimeErrorEvent = AcpRuntimeEventBase & {
  type: "error";
  message: string;
  code?: string;
  /** Error classification category for handling decisions */
  category?: AcpRuntimeErrorCategory;
  retryable?: boolean;
};

/**
 * Union type of all possible runtime events.
 *
 * Lifecycle semantics:
 * - started -> (text_delta | status | tool_call)* -> (done | error)
 * - Exactly one terminal event (done or error) MUST be emitted
 * - No events are emitted after a terminal event
 */
export type AcpRuntimeEvent =
  | AcpRuntimeStartedEvent
  | AcpRuntimeTextDeltaEvent
  | AcpRuntimeStatusEvent
  | AcpRuntimeToolCallEvent
  | AcpRuntimeDoneEvent
  | AcpRuntimeErrorEvent;

/**
 * Type guard to check if an event is a terminal event (done or error).
 */
export function isTerminalEvent(
  event: AcpRuntimeEvent,
): event is AcpRuntimeDoneEvent | AcpRuntimeErrorEvent {
  return event.type === "done" || event.type === "error";
}

/**
 * Type guard to check if an event is a non-terminal event.
 */
export function isNonTerminalEvent(
  event: AcpRuntimeEvent,
): event is Exclude<AcpRuntimeEvent, AcpRuntimeDoneEvent | AcpRuntimeErrorEvent> {
  return !isTerminalEvent(event);
}

export interface AcpRuntime {
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;

  runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;

  getCapabilities?(input: {
    handle?: AcpRuntimeHandle;
  }): Promise<AcpRuntimeCapabilities> | AcpRuntimeCapabilities;

  getStatus?(input: { handle: AcpRuntimeHandle }): Promise<AcpRuntimeStatus>;

  setMode?(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void>;

  setConfigOption?(input: { handle: AcpRuntimeHandle; key: string; value: string }): Promise<void>;

  doctor?(): Promise<AcpRuntimeDoctorReport>;

  cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void>;

  close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void>;
}

export type SessionAcpIdentitySource = "ensure" | "status" | "event";

export type SessionAcpIdentityState = "pending" | "resolved";

export type SessionAcpIdentity = {
  state: SessionAcpIdentityState;
  acpxRecordId?: string;
  acpxSessionId?: string;
  agentSessionId?: string;
  source: SessionAcpIdentitySource;
  lastUpdatedAt: number;
};

/**
 * Error classification at the session meta level.
 * Mirrors AcpRuntimeErrorCategory for consistency.
 */
export type SessionAcpErrorCategory =
  | "config" // Configuration-related errors
  | "policy" // Policy violations
  | "runtime" // Runtime execution errors
  | "network" // Network/communication errors
  | "cancelled"; // User-initiated cancellation

/**
 * Structured error information for session-level errors.
 */
export type SessionAcpError = {
  message: string;
  code?: string;
  category?: SessionAcpErrorCategory;
  timestamp: number;
  /** Whether the error is retryable */
  retryable?: boolean;
};

export type AcpSessionRuntimeOptions = {
  /**
   * ACP runtime mode set via session/set_mode (for example: "plan", "normal", "auto").
   */
  runtimeMode?: string;
  /** ACP runtime config option: model id. */
  model?: string;
  /** Working directory override for ACP session turns. */
  cwd?: string;
  /** ACP runtime config option: permission profile id. */
  permissionProfile?: string;
  /** ACP runtime config option: per-turn timeout in seconds. */
  timeoutSeconds?: number;
  /** Backend-specific option bag mapped through session/set_config_option. */
  backendExtras?: Record<string, string>;
};

/**
 * Session state reflects the lifecycle of a turn:
 * - idle: Ready to accept new turns
 * - running: A turn is currently in progress
 * - error: The last turn ended with an error (terminal state, will reset to idle on next turn)
 *
 * Terminal uniqueness constraint: When state is "error", lastError MUST be set.
 */
export type SessionAcpMeta = {
  backend: string;
  agent: string;
  runtimeSessionName: string;
  identity?: SessionAcpIdentity;
  mode: "persistent" | "oneshot";
  runtimeOptions?: AcpSessionRuntimeOptions;
  cwd?: string;
  state: "idle" | "running" | "error";
  lastActivityAt: number;
  /** @deprecated Use lastErrorDetails for structured error info */
  lastError?: string;
  /** Structured error details when state is "error" */
  lastErrorDetails?: SessionAcpError;
  /** Conversation keys bound to this session, persisted for restart hydration */
  conversationKeys?: string[];
};

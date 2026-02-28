export type AcpBridgeEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; name: string; args?: Record<string, unknown> }
  | { type: "tool_result"; name: string; output?: string }
  | { type: "done"; stopReason?: string }
  | { type: "error"; message: string };

export interface AcpBridgeRuntimeAdapter {
  /**
   * Send a message to the specified session and stream back events.
   */
  sendMessage(params: {
    sessionKey: string;
    text: string;
    attachments?: Array<{ type: string; mimeType: string; content: string }>;
    signal?: AbortSignal;
  }): AsyncIterable<AcpBridgeEvent>;

  /**
   * Abort an in-progress session run.
   */
  abortSession(sessionKey: string): Promise<void>;

  /**
   * Reset a session (clear history / start fresh).
   */
  resetSession(sessionKey: string): Promise<void>;

  /**
   * Resolve a session key by key or label. Returns null if not found.
   */
  resolveSessionKey(params: { key?: string; label?: string }): Promise<string | null>;

  /**
   * List available sessions.
   */
  listSessions(): Promise<Array<{ key: string; label?: string }>>;
}

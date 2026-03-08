import * as acp from "@agentclientprotocol/sdk";
import type { AcpTransportConnection } from "./transport";

export type AcpSessionInfo = {
  sessionId: string;
  cwd: string;
  currentMode?: string;
  availableModes?: string[];
};

export type AcpSessionSendOptions = {
  /** Prompt text to send */
  text: string;
  /** Optional attachments */
  attachments?: Array<{
    type: string;
    mimeType: string;
    content: string;
  }>;
  /** Optional abort signal */
  signal?: AbortSignal;
};

export type AcpSessionStatus = {
  sessionKey: string;
  backend: string;
  agent: string;
  state: "idle" | "running" | "error";
  mode: "persistent" | "oneshot";
  lastActivityAt: number;
  lastError?: string;
};

export type AcpSessionListEntry = {
  sessionKey: string;
  label?: string;
};

/**
 * ACP Client session wrapper.
 * Provides high-level methods for interacting with ACP sessions.
 */
export class AcpClientSession {
  private transport: AcpTransportConnection;
  private sessionId: string | null = null;
  private sessionKey: string;

  constructor(transport: AcpTransportConnection, sessionKey: string) {
    this.transport = transport;
    this.sessionKey = sessionKey;
  }

  /**
   * Creates a new ACP session.
   */
  async spawn(options: {
    cwd?: string;
    mcpServers?: acp.McpServer[];
    meta?: Record<string, unknown>;
  }): Promise<AcpSessionInfo> {
    const session = await this.transport.connection.newSession({
      cwd: options.cwd ?? process.cwd(),
      mcpServers: options.mcpServers ?? [],
      _meta: options.meta,
    });

    this.sessionId = session.sessionId;
    return {
      sessionId: session.sessionId,
      cwd: options.cwd ?? process.cwd(),
    };
  }

  /**
   * Loads an existing ACP session.
   */
  async load(options: {
    cwd?: string;
    mcpServers?: acp.McpServer[];
    meta?: Record<string, unknown>;
  }): Promise<AcpSessionInfo> {
    if (!this.sessionId) {
      // Use sessionKey as sessionId for loading
      this.sessionId = this.sessionKey;
    }

    await this.transport.connection.loadSession({
      sessionId: this.sessionId,
      cwd: options.cwd ?? process.cwd(),
      mcpServers: options.mcpServers ?? [],
      _meta: options.meta,
    });

    return {
      sessionId: this.sessionId,
      cwd: options.cwd ?? process.cwd(),
    };
  }

  /**
   * Sends a prompt to the session and returns the response.
   */
  async send(options: AcpSessionSendOptions): Promise<acp.PromptResponse> {
    if (!this.sessionId) {
      throw new Error("Session not initialized. Call spawn() or load() first.");
    }

    const prompt: acp.ContentBlock[] = [
      {
        type: "text",
        text: options.text,
      },
    ];

    if (options.attachments) {
      for (const attachment of options.attachments) {
        prompt.push({
          type: "resource",
          resource: {
            uri: "",
            mimeType: attachment.mimeType,
            text: attachment.content,
          },
        });
      }
    }

    return await this.transport.connection.prompt({
      sessionId: this.sessionId,
      prompt,
      _meta: {},
    });
  }

  /**
   * Cancels the current session operation.
   */
  async cancel(): Promise<void> {
    if (!this.sessionId) {
      throw new Error("Session not initialized.");
    }

    await this.transport.connection.cancel({
      sessionId: this.sessionId,
    });
  }

  /**
   * Gets the current session status.
   */
  async status(): Promise<acp.PromptResponse | null> {
    if (!this.sessionId) {
      throw new Error("Session not initialized.");
    }

    // Note: ACP doesn't have a direct status method for individual sessions
    // This would typically be handled by the bridge server
    // For now, return null or implement bridge-specific status endpoint
    return null;
  }

  /**
   * Changes the session mode.
   */
  async setMode(mode: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("Session not initialized.");
    }

    await this.transport.connection.setSessionMode({
      sessionId: this.sessionId,
      modeId: mode,
    });
  }

  /**
   * Lists available sessions.
   */
  async listSessions(cwd?: string): Promise<AcpSessionListEntry[]> {
    const result = await this.transport.connection.unstable_listSessions({
      cwd: cwd ?? process.cwd(),
    });

    return result.sessions.map((session) => ({
      sessionKey: session.sessionId,
      label: session.title ?? undefined,
    }));
  }

  /**
   * Gets the session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Closes the session.
   */
  async close(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.transport.connection.cancel({
          sessionId: this.sessionId,
        });
      } catch {
        // Ignore cancel errors
      }
    }
  }
}

/**
 * Creates a new ACP client session.
 */
export async function createAcpClientSession(
  transport: AcpTransportConnection,
  sessionKey: string,
): Promise<AcpClientSession> {
  return new AcpClientSession(transport, sessionKey);
}

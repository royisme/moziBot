import type { SessionId } from "@agentclientprotocol/sdk";

export type AcpSession = {
  sessionId: SessionId;
  sessionKey: string;
  cwd: string;
  createdAt: number;
  lastTouchedAt: number;
  abortController: AbortController | null;
  activeRunId: string | null;
};

export type AcpServerOptions = {
  runtimeHost?: string;
  defaultSessionKey?: string;
  defaultSessionLabel?: string;
  requireExistingSession?: boolean;
  resetSession?: boolean;
  prefixCwd?: boolean;
  sessionCreateRateLimit?: {
    maxRequests?: number;
    windowMs?: number;
  };
  verbose?: boolean;
};

export const ACP_AGENT_INFO = {
  name: "mozibot-acp",
  title: "moziBot ACP Gateway",
  version: "0.1.0",
};

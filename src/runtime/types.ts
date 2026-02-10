import type { MoziConfig } from "../config";

export type ModelApi =
  | "openai-responses"
  | "openai-completions"
  | "anthropic-messages"
  | "google-generative-ai";

export type ProviderConfig = {
  id: string;
  api?: ModelApi;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: ModelDefinition[];
};

export type ModelDefinition = {
  id: string;
  name?: string;
  api?: ModelApi;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "audio" | "video" | "file">;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
};

export type ModelSpec = {
  id: string;
  provider: string;
  api: ModelApi;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "audio" | "video" | "file">;
  contextWindow?: number;
  maxTokens?: number;
};

export type ModelRef = {
  provider: string;
  model: string;
};

export type SessionState = {
  sessionKey: string;
  agentId: string;
  latestSessionId?: string;
  latestSessionFile?: string;
  historySessionIds?: string[];
  segments?: Record<string, SessionSegmentState>;
  sessionId?: string;
  sessionFile?: string;
  createdAt?: number;
  updatedAt?: number;
  currentModel?: string;
  context?: unknown;
  metadata?: Record<string, unknown>;
};

export type SessionSegmentState = {
  sessionId: string;
  sessionFile: string;
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
  summary?: string;
  prevSessionId?: string;
  nextSessionId?: string;
};

export type RegistryContext = {
  config: MoziConfig;
};

import type { MoziConfig } from "../config";
import type { MODEL_APIS } from "../config/schema/models";
import type { SecretInput } from "../storage/secrets/types";

export type ModelApi = (typeof MODEL_APIS)[number];

export type ModelProviderAuthMode = "api-key" | "aws-sdk" | "oauth" | "token";

export type ModelCompatConfig = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsTools?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  thinkingFormat?: "openai" | "zai" | "qwen";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresMistralToolIds?: boolean;
  requiresOpenAiAnthropicToolPayload?: boolean;
};

export type ProviderTransportKind = "openai-compat" | "native-sdk" | "cli-backend";

export type ProviderContract = {
  id: string;
  canonicalApi?: ModelApi;
  canonicalBaseUrl?: string;
  canonicalHeaders?: Record<string, string>;
  nativeSdk?: true;
  auth?: ModelProviderAuthMode;
  authModes?: ModelProviderAuthMode[];
  apiEnvVar?: string;
  catalog?: ModelDefinition[];
  transportKind?: ProviderTransportKind;
};

export type ProviderConfig = {
  id: string;
  api?: ModelApi;
  auth?: ModelProviderAuthMode;
  baseUrl?: string;
  apiKey?: SecretInput;
  injectNumCtxForOpenAICompat?: boolean;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: ModelDefinition[];
  transportKind?: ProviderTransportKind;
};

export type ResolvedProvider = ProviderConfig & {
  transportKind: ProviderTransportKind;
};

export type ModelDefinition = {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "audio" | "video" | "file">;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: ModelCompatConfig;
};

export type ModelSpec = {
  id: string;
  provider: string;
  api: ModelApi;
  baseUrl?: string;
  apiKey?: SecretInput;
  headers?: Record<string, string>;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "audio" | "video" | "file">;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  compat?: ModelCompatConfig;
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

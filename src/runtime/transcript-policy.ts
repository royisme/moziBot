import type { ModelApi } from "./types";

export type ToolCallIdMode = "strict" | "strict9";

export type TranscriptPolicy = {
  sanitizeToolCallIds: boolean;
  toolCallIdMode?: ToolCallIdMode;
  repairToolUseResultPairing: boolean;
  allowSyntheticToolResults: boolean;
  applyGoogleTurnOrdering: boolean;
  validateGeminiTurns: boolean;
  validateAnthropicTurns: boolean;
  sanitizeThinkingSignatures: boolean;
};

const OPENAI_APIS = new Set<ModelApi>(["openai-responses", "openai-completions"]);

function isOpenAiApi(api?: string): boolean {
  return api ? OPENAI_APIS.has(api as ModelApi) : false;
}

function isMistralTarget(provider?: string, modelRef?: string): boolean {
  const p = (provider || "").toLowerCase();
  const model = (modelRef || "").toLowerCase();
  if (p.includes("mistral")) {
    return true;
  }
  return ["mistral", "mixtral", "codestral", "pixtral", "ministral"].some((hint) =>
    model.includes(hint),
  );
}

function isAnthropicTarget(api?: string, provider?: string): boolean {
  if (api === "anthropic-messages") {
    return true;
  }
  return (provider || "").toLowerCase().includes("anthropic");
}

export function resolveTranscriptPolicy(params: {
  modelRef: string;
  api?: string;
  provider?: string;
}): TranscriptPolicy {
  const modelRef = params.modelRef.toLowerCase();
  const provider = (params.provider || "").toLowerCase();
  const api = params.api;

  const isGeminiModel = modelRef.includes("gemini");
  const isOpenAi = isOpenAiApi(api) && !isGeminiModel;
  const isGoogle = api === "google-generative-ai" || isGeminiModel;
  const isAnthropic = isAnthropicTarget(api, provider);
  const isMistral = isMistralTarget(provider, modelRef);
  const isOpenRouterGemini =
    (provider === "openrouter" || provider === "opencode") && isGeminiModel;

  const sanitizeToolCallIds = isMistral || (!isOpenAi && isGoogle);
  const toolCallIdMode: ToolCallIdMode | undefined = isMistral
    ? "strict9"
    : sanitizeToolCallIds
      ? "strict"
      : undefined;

  return {
    sanitizeToolCallIds,
    toolCallIdMode,
    repairToolUseResultPairing: !isOpenAi && (isGoogle || isAnthropic),
    allowSyntheticToolResults: !isOpenAi && (isGoogle || isAnthropic),
    applyGoogleTurnOrdering: !isOpenAi && isGoogle,
    validateGeminiTurns: !isOpenAi && isGoogle,
    validateAnthropicTurns: !isOpenAi && isAnthropic,
    sanitizeThinkingSignatures: !isOpenAi && isOpenRouterGemini,
  };
}

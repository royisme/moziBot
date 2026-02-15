import type { PromptFlow, PreparedPromptBundle } from "../contract";

/**
 * Runtime-guarded helper to ensure a function exists on an unknown object.
 */
function requireFn<T>(deps: unknown, key: string): T {
  const obj = deps as Record<string, unknown>;
  const fn = obj[key];
  if (typeof fn !== "function") {
    throw new Error(`Missing required dependency function: ${key}`);
  }
  return fn as T;
}

/**
 * Prompt Flow Implementation
 *
 * Orchestrates the preparation of a prompt for execution:
 * - Media preprocessing and transcription
 * - Capability validation
 * - Ingest plan generation
 * - Final prompt text construction
 */
export const runPromptFlow: PromptFlow = async (ctx, deps) => {
  const { state, payload } = ctx;

  try {
    // Narrow guard for required artifacts from state
    const baseText = typeof state.text === "string" ? state.text : undefined;
    const sessionKey = typeof state.sessionKey === "string" ? state.sessionKey : undefined;
    const agentId = typeof state.agentId === "string" ? state.agentId : undefined;
    const peerId = typeof state.peerId === "string" ? state.peerId : undefined;
    const inlineOverrides =
      state.inlineOverrides && typeof state.inlineOverrides === "object"
        ? (state.inlineOverrides as {
            thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
            reasoningLevel?: "off" | "on" | "stream";
            promptText?: string;
          })
        : undefined;

    const text =
      inlineOverrides && typeof inlineOverrides.promptText === "string"
        ? inlineOverrides.promptText
        : baseText;

    if (text === undefined || !sessionKey || !agentId || !peerId) {
      // Critical preparation context missing
      return "abort";
    }

    // Dependency extraction
    const transcribeMessage = requireFn<(p: unknown) => Promise<string | undefined>>(
      deps,
      "transcribeInboundMessage",
    );
    const checkCapability = requireFn<
      (p: {
        sessionKey: string;
        agentId: string;
        message: unknown;
        peerId: string;
        hasAudioTranscript: boolean;
      }) => Promise<{ ok: boolean; restoreModelRef?: string }>
    >(deps, "checkInputCapability");
    const buildIngestPlan = requireFn<
      (p: { message: unknown; sessionKey: string; agentId: string }) => unknown
    >(deps, "ingestInboundMessage");
    const buildFinalText = requireFn<
      (p: { message: unknown; rawText: string; transcript?: string; ingestPlan: unknown }) => string
    >(deps, "buildPromptText");
    const updateMetadata = requireFn<(sk: string, meta: Record<string, unknown>) => void>(
      deps,
      "updateSessionMetadata",
    );
    const maybePreFlushBeforePrompt = requireFn<
      (params: { sessionKey: string; agentId: string }) => Promise<void>
    >(deps, "maybePreFlushBeforePrompt");

    // 1. Media Preprocessing
    const transcript = await transcribeMessage(payload);
    const hasAudioTranscript = typeof transcript === "string" && transcript.trim().length > 0;

    // 2. Capability Validation
    const capability = await checkCapability({
      sessionKey,
      agentId,
      message: payload,
      peerId,
      hasAudioTranscript,
    });

    if (!capability.ok) {
      return "continue"; // Handled via degradation notification in service
    }

    state.capabilityRestoreModelRef = capability.restoreModelRef;

    // 3. Ingest Plan Retrieval
    const ingestPlan = await buildIngestPlan({
      message: payload,
      sessionKey,
      agentId,
    });

    state.ingestPlan = ingestPlan;

    // Monolith logic: update session metadata with the plan
    updateMetadata(sessionKey, {
      multimodal: {
        inboundPlan: ingestPlan,
      },
    });

    if (inlineOverrides?.thinkingLevel || inlineOverrides?.reasoningLevel) {
      updateMetadata(sessionKey, {
        ...(inlineOverrides.thinkingLevel ? { thinkingLevel: inlineOverrides.thinkingLevel } : {}),
        ...(inlineOverrides.reasoningLevel
          ? { reasoningLevel: inlineOverrides.reasoningLevel }
          : {}),
      });
    }

    await maybePreFlushBeforePrompt({ sessionKey, agentId });

    // 4. Final Prompt Text Building
    const promptText = buildFinalText({
      message: payload,
      rawText: text,
      transcript: transcript || undefined,
      ingestPlan,
    });

    state.promptText = promptText;

    // 5. Produce Prepared Bundle
    const bundle: PreparedPromptBundle = {
      promptId: ctx.messageId, // Using messageId as promptId for tracking
      agentId,
      config: {
        promptText,
        ingestPlan,
      },
    };

    return bundle;
  } catch {
    // TODO: Connect to centralized error flow
    return "abort";
  }
};

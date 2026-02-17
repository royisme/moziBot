import type { PromptFlow, PreparedPromptBundle } from "../contract";
import { getRuntimeHookRunner } from "../../../hooks";

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
  const transcribeMessage = (p: unknown) => deps.transcribeInboundMessage(p);
  const checkCapability = (params: {
    sessionKey: string;
    agentId: string;
    message: unknown;
    peerId: string;
    hasAudioTranscript: boolean;
  }) => deps.checkInputCapability(params);
  const buildIngestPlan = (params: { message: unknown; sessionKey: string; agentId: string }) =>
    deps.ingestInboundMessage(params);
  const buildFinalText = (params: {
    message: unknown;
    rawText: string;
    transcript?: string;
    ingestPlan: unknown;
  }) => deps.buildPromptText(params);
  const updateMetadata = (sessionKey: string, meta: Record<string, unknown>) =>
    deps.updateSessionMetadata(sessionKey, meta);
  const maybePreFlushBeforePrompt = (params: { sessionKey: string; agentId: string }) =>
    deps.maybePreFlushBeforePrompt(params);

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
    let promptText = buildFinalText({
      message: payload,
      rawText: text,
      transcript: transcript || undefined,
      ingestPlan,
    });

    const hookRunner = getRuntimeHookRunner();
    if (hookRunner.hasHooks("before_agent_start")) {
      const hookResult = await hookRunner.runBeforeAgentStart(
        {
          promptText,
          ingestPlan,
        },
        {
          sessionKey,
          agentId,
          traceId: ctx.traceId,
          messageId: ctx.messageId,
        },
      );
      if (hookResult?.block) {
        return "abort";
      }
      if (typeof hookResult?.promptText === "string") {
        promptText = hookResult.promptText;
      }
    }

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

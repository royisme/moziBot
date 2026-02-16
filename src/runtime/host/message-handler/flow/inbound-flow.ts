import type { InboundFlow } from "../contract";

/**
 * Inbound Flow Implementation
 *
 * Orchestrates pre-command setup: extraction, command parsing, session resolution,
 * reminder short-circuiting, and initial logging.
 * Preserves monolith parity and uses narrow runtime-guarded access for dependencies.
 */
export const runInboundFlow: InboundFlow = async (ctx, deps) => {
  const { payload, state } = ctx;
  const getText = (p: unknown) => deps.getText(p);
  const getMedia = (p: unknown) => deps.getMedia(p);
  const normalizeControl = (t: string) => deps.normalizeImplicitControlCommand(t);
  const parseCommand = (t: string) => deps.parseCommand(t);
  const resolveContext = (p: unknown) => deps.resolveSessionContext(p);
  const rememberRoute = (agentId: string, p: unknown) => deps.rememberLastRoute(agentId, p);
  const sendDirect = (peerId: string, text: string) => deps.sendDirect(peerId, text);
  const parseInlineOverrides = (parsed: { name: string; args: string } | null) =>
    deps.parseInlineOverrides(parsed);
  const { logger } = deps;

  try {
    // 1. Extraction & Empty Check
    const rawText = getText(payload);
    const media = getMedia(payload);

    if (!rawText.trim() && media.length === 0) {
      state.inboundHandled = true;
      return "continue";
    }

    // 2. Normalization & Parsing
    const normalizedText = normalizeControl(rawText);

    // Parity: parseCommand(normalizedControlCommand ?? text)
    const parsedCommand = parseCommand(normalizedText ?? rawText);
    const inlineOverrides = parseInlineOverrides(parsedCommand);

    // Unsupported slash command check: must use original text.startsWith('/')
    if (rawText.startsWith("/") && !parsedCommand) {
      logger.info({ text: rawText }, "Ignoring unsupported slash command");
      return "handled";
    }

    // 3. Session Resolution
    const context = resolveContext(payload);
    rememberRoute(context.agentId, payload);

    // 4. Reminder Short-Circuit
    const isReminder =
      payload &&
      typeof payload === "object" &&
      "raw" in (payload as Record<string, unknown>) &&
      (() => {
        const raw = (payload as Record<string, unknown>).raw;
        if (!raw || typeof raw !== "object") {
          return false;
        }
        return (raw as Record<string, unknown>).source === "reminder";
      })();
    if (isReminder) {
      const replyText = rawText.trim() || "Reminder";
      await sendDirect(context.peerId, replyText);
      logger.info({ sessionKey: context.sessionKey }, "Reminder delivered");
      return "handled";
    }

    // 5. Store Computed Artifacts
    state.text = rawText;
    state.normalizedControlCommand = normalizedText;
    state.parsedCommand = parsedCommand;
    state.inlineOverrides = inlineOverrides;
    state.agentId = context.agentId;
    state.sessionKey = context.sessionKey;
    state.peerId = context.peerId;
    state.dmScope = context.dmScope;
    state.startedAt = ctx.startTime;

    // 6. Logging
    logger.info(
      {
        traceId: ctx.traceId,
        messageId: ctx.messageId,
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        isCommand: !!parsedCommand,
      },
      "Inbound message processing started",
    );

    return "continue";
  } catch {
    // TODO: Connect to centralized error flow
    return "abort";
  }
};

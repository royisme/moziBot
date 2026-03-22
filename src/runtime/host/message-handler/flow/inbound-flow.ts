import { getRuntimeHookRunner } from "../../../hooks";
import type { RouteContext } from "../../routing/types";
import type { InboundFlow } from "../contract";
import { isSystemInternalTurnSource } from "../services/reply-finalizer";

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
  const rememberRoute = (agentId: string, route: RouteContext) =>
    deps.rememberLastRoute(agentId, route);
  const sendDirect = (peerId: string, text: string) => deps.sendDirect(peerId, text);
  const getChannel = (p: unknown) => deps.getChannel(p);
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
    rememberRoute(context.agentId, context.route);

    const hookRunner = getRuntimeHookRunner();
    if (hookRunner.hasHooks("message_received")) {
      const channel = getChannel(payload);
      await hookRunner.runMessageReceived(
        {
          traceId: ctx.traceId,
          messageId: ctx.messageId,
          text: rawText,
          normalizedText,
          rawStartsWithSlash: rawText.startsWith("/"),
          isCommand: Boolean(parsedCommand),
          commandName: parsedCommand?.name,
          commandArgs: parsedCommand?.args,
          mediaCount: media.length,
        },
        {
          sessionKey: context.sessionKey,
          agentId: context.agentId,
          peerId: context.peerId,
          channelId: channel?.id,
          dmScope: context.dmScope,
        },
      );
    }

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

    // 4b. System-Internal Turn Short-Circuit
    // Turns from sources like "subagent-announce" and "heartbeat" require no LLM execution.
    // Short-circuit here — before execution-flow — to avoid starting a typing indicator,
    // making an LLM API call, and then suppressing the reply after the fact.
    const turnSource =
      payload && typeof payload === "object" && "raw" in (payload as Record<string, unknown>)
        ? ((payload as Record<string, unknown>).raw as { source?: unknown } | undefined)?.source
        : undefined;
    if (isSystemInternalTurnSource(turnSource as string | undefined)) {
      logger.info(
        { sessionKey: context.sessionKey, turnSource },
        "System-internal turn short-circuited in inbound-flow; skipping execution",
      );
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
    state.route = context.route;
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

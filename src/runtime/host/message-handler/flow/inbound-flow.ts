import type { InboundFlow } from "../contract";

/**
 * Runtime-guarded helper to ensure a function exists on an unknown object.
 */
type UnknownRecord = Record<string, unknown>;

function requireFn<T>(obj: unknown, key: string): T {
  if (!obj || typeof obj !== "object") {
    throw new Error(`Missing required dependency object for function: ${key}`);
  }
  const fn = (obj as UnknownRecord)[key];
  if (typeof fn !== "function") {
    throw new Error(`Missing required dependency function: ${key}`);
  }
  return fn as T;
}

/**
 * Runtime-guarded helper to ensure an object exists on an unknown object.
 */
function requireObj<T extends object>(obj: unknown, key: string): T {
  if (!obj || typeof obj !== "object") {
    throw new Error(`Missing required dependency object container for key: ${key}`);
  }
  const target = (obj as UnknownRecord)[key];
  if (!target || typeof target !== "object") {
    throw new Error(`Missing required dependency object: ${key}`);
  }
  return target as T;
}

/**
 * Inbound Flow Implementation
 * 
 * Orchestrates pre-command setup: extraction, command parsing, session resolution,
 * reminder short-circuiting, and initial logging.
 * Preserves monolith parity and uses narrow runtime-guarded access for dependencies.
 */
export const runInboundFlow: InboundFlow = async (ctx, deps) => {
  const { payload, state } = ctx;

  try {
    // Narrow dependency access
    const getText = requireFn<(p: unknown) => string>(deps, "getText");
    const getMedia = requireFn<(p: unknown) => unknown[]>(deps, "getMedia");
    const normalizeControl = requireFn<(t: string) => string | null>(
      deps,
      "normalizeImplicitControlCommand",
    );
    const parseCommand = requireFn<(t: string) => { name: string; args: string } | null>(
      deps,
      "parseCommand",
    );
    const resolveContext = requireFn<
      (p: unknown) => { agentId: string; sessionKey: string; peerId: string; dmScope?: string }
    >(deps, "resolveSessionContext");
    const rememberRoute = requireFn<(a: string, p: unknown) => void>(deps, "rememberLastRoute");
    const sendDirect = requireFn<(p: string, t: string) => Promise<void>>(deps, "sendDirect");
    const logger = requireObj<{ info: (o: Record<string, unknown>, m: string) => void }>(deps, "logger");

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
    const parseInlineOverrides = requireFn<
      (parsed: { name: string; args: string } | null) =>
        | {
            thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
            reasoningLevel?: "off" | "on" | "stream";
            promptText: string;
          }
        | null
    >(deps, "parseInlineOverrides");
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
      "raw" in (payload as UnknownRecord) &&
      (() => {
        const raw = (payload as UnknownRecord).raw;
        if (!raw || typeof raw !== "object") {
          return false;
        }
        return (raw as UnknownRecord).source === "reminder";
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
    logger.info({
      traceId: ctx.traceId,
      messageId: ctx.messageId,
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      isCommand: !!parsedCommand,
    }, "Inbound message processing started");

    return "continue";
  } catch {
    // TODO: Connect to centralized error flow
    return "abort";
  }
};

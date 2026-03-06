import type { ImageContent } from "@mariozechner/pi-ai";
import { agentEvents } from "../../../../infra/agent-events";
import { getRuntimeHookRunner } from "../../../hooks";
import {
  handleAgentStreamEvent,
  type AgentSessionEvent,
  type StreamingCallback,
} from "./streaming";

/**
 * Prompt Runner and Active Run Bookkeeping Service
 *
 * Manages the execution lifecycle of agent prompts, including fallback model loops,
 * active run tracking, and event routing.
 */

export interface ActivePromptRun {
  readonly agentId: string;
  readonly modelRef: string;
  readonly startedAt: number;
  readonly agent: PromptAgent;
  readonly abortRun?: (reason?: unknown) => void;
}

export interface PromptAgent {
  prompt(
    text: string,
    options?: {
      streamingBehavior?: "steer" | "followUp";
      images?: ImageContent[];
    },
  ): Promise<void> | void;
  abort?: () => Promise<void> | void;
  followUp?: (message: string) => Promise<void> | void;
  steer?: (message: string) => Promise<void> | void;
  subscribe?: (listener: (event: unknown) => void) => () => void;
  messages?: unknown[];
}

export interface FallbackInfo {
  readonly fromModel: string;
  readonly toModel: string;
  readonly attempt: number;
  readonly error: string;
}

export interface PromptRunnerDeps {
  readonly logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  readonly agentManager: {
    getAgent(
      sessionKey: string,
      agentId: string,
    ): Promise<{ agent: PromptAgent; modelRef: string }>;
    getAgentFallbacks(agentId: string): string[];
    setSessionModel(
      sessionKey: string,
      modelRef: string,
      options: { persist: boolean },
    ): Promise<void>;
    clearRuntimeModelOverride(sessionKey: string): void;
    resolvePromptTimeoutMs(agentId: string): number;
  };
  readonly errorClassifiers: {
    isAgentBusyError(err: unknown): boolean;
    isContextOverflowError(message: string): boolean;
    isAbortError(error: Error): boolean;
    isTransientError(message: string): boolean;
    toError(err: unknown): Error;
  };
}

function isPromptOptionsUnsupportedError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    (message.includes("streamingbehavior") &&
      (message.includes("unsupported") ||
        message.includes("unknown") ||
        message.includes("invalid") ||
        message.includes("not supported"))) ||
    (message.includes("argument") &&
      (message.includes("expected 1") ||
        message.includes("too many") ||
        message.includes("cannot be invoked")))
  );
}

async function callPromptWithQueueBehavior(
  agent: PromptAgent,
  text: string,
  images: ImageContent[] | undefined,
  deps: Pick<PromptRunnerDeps, "logger" | "errorClassifiers">,
  meta: {
    traceId?: string;
    sessionKey: string;
    agentId: string;
    modelRef: string;
    attempt: number;
  },
): Promise<void> {
  const promptOptions = images?.length
    ? { streamingBehavior: "followUp" as const, images }
    : { streamingBehavior: "followUp" as const };

  try {
    await Promise.resolve(agent.prompt(text, promptOptions));
    return;
  } catch (error) {
    if (!isPromptOptionsUnsupportedError(error)) {
      throw error;
    }
    deps.logger.warn(
      {
        traceId: meta.traceId,
        sessionKey: meta.sessionKey,
        agentId: meta.agentId,
        modelRef: meta.modelRef,
        attempt: meta.attempt,
        error: deps.errorClassifiers.toError(error).message,
      },
      "Agent prompt options unsupported; falling back to followUp/steer",
    );
  }

  if (images?.length) {
    await Promise.resolve(agent.prompt(text, { images }));
    return;
  }

  if (typeof agent.followUp === "function") {
    await Promise.resolve(agent.followUp(text));
    return;
  }

  if (typeof agent.steer === "function") {
    await Promise.resolve(agent.steer(text));
    return;
  }

  await Promise.resolve(agent.prompt(text));
}

function redactSensitiveText(text: string): string {
  if (!text) {
    return "";
  }
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-<redacted>")
    .replace(/(Bearer\\s+)[A-Za-z0-9._-]{16,}/gi, "$1<redacted>")
    .replace(/("(?:apiKey|token|authToken|botToken)"\\s*:\\s*")[^"]+("\\s*)/gi, "$1<redacted>$2");
}

/**
 * Registers an active prompt run in the bookkeeping maps.
 */
export function registerActivePromptRun(
  activeMap: Map<string, ActivePromptRun>,
  interruptedSet: Set<string>,
  params: { sessionKey: string } & ActivePromptRun,
): void {
  const { sessionKey, ...run } = params;
  interruptedSet.delete(sessionKey);
  activeMap.set(sessionKey, run);
}

/**
 * Clears an active prompt run from the bookkeeping maps.
 */
export function clearActivePromptRun(
  activeMap: Map<string, ActivePromptRun>,
  interruptedSet: Set<string>,
  sessionKey: string,
): void {
  activeMap.delete(sessionKey);
  interruptedSet.delete(sessionKey);
}

/**
 * Waits for the agent to reach an idle state (settle delay).
 */
export async function waitForAgentIdle(_agent: PromptAgent, timeoutMs = 50): Promise<void> {
  const settleDelayMs = Math.min(timeoutMs, 50);
  await new Promise<void>((resolve) => setTimeout(resolve, settleDelayMs));
}

function resolveRunId(traceId?: string): string {
  const trimmed = traceId?.trim();
  if (trimmed) {
    return trimmed;
  }
  return crypto.randomUUID();
}

function toStreamEvent(event: unknown): AgentSessionEvent | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const value = event as Record<string, unknown>;
  if (value.type === "message_update") {
    const assistantMessageEvent = value.assistantMessageEvent;
    if (!assistantMessageEvent || typeof assistantMessageEvent !== "object") {
      return undefined;
    }
    const assistant = assistantMessageEvent as Record<string, unknown>;
    if (assistant.type === "text_delta" && typeof assistant.delta === "string") {
      return {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: assistant.delta },
      };
    }
    return undefined;
  }
  if (
    value.type === "tool_execution_start" &&
    typeof value.toolName === "string" &&
    typeof value.toolCallId === "string"
  ) {
    return {
      type: "tool_execution_start",
      toolName: value.toolName,
      toolCallId: value.toolCallId,
    };
  }
  if (
    value.type === "tool_execution_end" &&
    typeof value.toolName === "string" &&
    typeof value.toolCallId === "string"
  ) {
    return {
      type: "tool_execution_end",
      toolName: value.toolName,
      toolCallId: value.toolCallId,
      isError: value.isError === true,
    };
  }
  return undefined;
}

/**
 * Orchestrates a prompt execution with automatic model fallbacks.
 * Preserves monolith runPromptWithFallback behavior exactly.
 */
export async function runPromptWithFallback(params: {
  sessionKey: string;
  agentId: string;
  text: string;
  images?: ImageContent[];
  traceId?: string;
  onStream?: StreamingCallback;
  onFallback?: (info: FallbackInfo) => Promise<void> | void;
  onContextOverflow?: (attempt: number) => Promise<void>;
  abortSignal?: AbortSignal;
  deps: PromptRunnerDeps;
  activeMap: Map<string, ActivePromptRun>;
  interruptedSet: Set<string>;
}): Promise<void> {
  const {
    sessionKey,
    agentId,
    text,
    images,
    traceId,
    onStream,
    onFallback,
    onContextOverflow,
    abortSignal,
    deps,
    activeMap,
    interruptedSet,
  } = params;

  const fallbacks = deps.agentManager.getAgentFallbacks(agentId);
  const tried = new Set<string>();
  let attempt = 0;
  let overflowCompactionAttempts = 0;
  const promptExecutionTimeoutMs = deps.agentManager.resolvePromptTimeoutMs(agentId);
  const promptProgressLogIntervalMs = 30_000;
  const runId = resolveRunId(traceId);
  const startedAt = Date.now();
  const hookRunner = getRuntimeHookRunner();
  const hasLlmInputHooks = hookRunner.hasHooks("llm_input");
  const hasLlmOutputHooks = hookRunner.hasHooks("llm_output");
  const hasAgentEndHooks = hookRunner.hasHooks("agent_end");
  let lastAgent: PromptAgent | undefined;

  agentEvents.emitLifecycle({
    runId,
    sessionKey,
    data: { phase: "start", startedAt },
  });

  try {
    while (true) {
      const { agent, modelRef } = await deps.agentManager.getAgent(sessionKey, agentId);
      lastAgent = agent;
      attempt += 1;
      const attemptStartedAt = Date.now();

      const progressTimer = setInterval(() => {
        deps.logger.warn(
          {
            traceId,
            sessionKey,
            agentId,
            modelRef,
            attempt,
            elapsedMs: Date.now() - attemptStartedAt,
            textChars: text.length,
          },
          "Agent prompt still running",
        );
      }, promptProgressLogIntervalMs);

      let unsubscribe: (() => void) | undefined;
      let accumulatedText = "";
      const runAbortController = new AbortController();
      let aborted = false;
      const abortRun = (reason?: unknown): void => {
        if (aborted) {
          return;
        }
        aborted = true;
        runAbortController.abort(reason);
        if (typeof agent.abort === "function") {
          void Promise.resolve(agent.abort()).catch(() => undefined);
        }
      };

      try {
        registerActivePromptRun(activeMap, interruptedSet, {
          sessionKey,
          agentId,
          modelRef,
          startedAt,
          agent,
          abortRun,
        });

        if (onStream && typeof agent.subscribe === "function") {
          unsubscribe = agent.subscribe((agentEvent: unknown) => {
            const mapped = toStreamEvent(agentEvent);
            if (!mapped) {
              return;
            }
            if (mapped.type === "tool_execution_start") {
              agentEvents.emitTool({
                runId,
                sessionKey,
                data: {
                  toolName: mapped.toolName,
                  status: "called",
                },
              });
            } else if (mapped.type === "tool_execution_end") {
              agentEvents.emitTool({
                runId,
                sessionKey,
                data: {
                  toolName: mapped.toolName,
                  status: mapped.isError ? "error" : "completed",
                },
              });
            }
            void handleAgentStreamEvent(
              mapped,
              async (streamEvent) => {
                await onStream({ ...streamEvent, runId });
              },
              (delta) => {
                accumulatedText += delta;
              },
            );
          });
        }

        if (abortSignal) {
          if (abortSignal.aborted) {
            abortRun(abortSignal.reason ?? new Error("Agent prompt aborted"));
          } else {
            const onExternalAbort = () => {
              abortRun(abortSignal.reason ?? new Error("Agent prompt aborted"));
            };
            abortSignal.addEventListener("abort", onExternalAbort, { once: true });
            runAbortController.signal.addEventListener(
              "abort",
              () => {
                abortSignal.removeEventListener("abort", onExternalAbort);
              },
              { once: true },
            );
          }
        }

        const abortable = async <T>(promise: Promise<T>): Promise<T> => {
          const signal = runAbortController.signal;
          if (signal.aborted) {
            throw deps.errorClassifiers.toError(signal.reason ?? new Error("Agent prompt aborted"));
          }

          return await new Promise<T>((resolve, reject) => {
            const onAbort = () => {
              reject(
                deps.errorClassifiers.toError(signal.reason ?? new Error("Agent prompt aborted")),
              );
            };
            signal.addEventListener("abort", onAbort, { once: true });
            promise.then(
              (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
              },
              (err) => {
                signal.removeEventListener("abort", onAbort);
                reject(err);
              },
            );
          });
        };

        const timeoutHandle = setTimeout(() => {
          abortRun(new Error("Agent prompt timeout"));
        }, promptExecutionTimeoutMs);

        try {
          if (hasLlmInputHooks) {
            await hookRunner.runLlmInput(
              {
                traceId,
                runId,
                modelRef,
                attempt,
                promptText: redactSensitiveText(text),
              },
              {
                sessionKey,
                agentId,
              },
            );
          }

          await abortable(
            callPromptWithQueueBehavior(agent, text, images, deps, {
              traceId,
              sessionKey,
              agentId,
              modelRef,
              attempt,
            }),
          );

          if (onStream) {
            await onStream({ type: "agent_end", runId, fullText: accumulatedText });
          }
          if (hasLlmOutputHooks) {
            await hookRunner.runLlmOutput(
              {
                traceId,
                runId,
                modelRef,
                attempt,
                status: "success",
                durationMs: Math.max(0, Date.now() - attemptStartedAt),
                outputText: accumulatedText ? redactSensitiveText(accumulatedText) : undefined,
              },
              {
                sessionKey,
                agentId,
              },
            );
          }
          break; // Success
        } finally {
          clearTimeout(timeoutHandle);
        }
      } catch (err) {
        const error = deps.errorClassifiers.toError(err);

        if (hasLlmOutputHooks) {
          await hookRunner.runLlmOutput(
            {
              traceId,
              runId,
              modelRef,
              attempt,
              status: "error",
              durationMs: Math.max(0, Date.now() - attemptStartedAt),
              error: error.message,
            },
            {
              sessionKey,
              agentId,
            },
          );
        }

        if (interruptedSet.has(sessionKey)) {
          const abortError = new Error("Interrupted by queue mode");
          abortError.name = "AbortError";
          throw abortError;
        }

        if (deps.errorClassifiers.isAbortError(error)) {
          throw error;
        }

        if (deps.errorClassifiers.isContextOverflowError(error.message) && onContextOverflow) {
          overflowCompactionAttempts++;
          await onContextOverflow(overflowCompactionAttempts);
          continue; // Retry overflow
        }

        // Handle Fallback
        tried.add(modelRef);
        const nextModel = fallbacks.find((m) => !tried.has(m));

        if (nextModel) {
          await deps.agentManager.setSessionModel(sessionKey, nextModel, { persist: false });
          if (onFallback) {
            await onFallback({
              fromModel: modelRef,
              toModel: nextModel,
              attempt: tried.size,
              error: error.message,
            });
          }
          continue;
        }

        throw err; // No more fallbacks
      } finally {
        clearInterval(progressTimer);
        if (unsubscribe) {
          unsubscribe();
        }
        clearActivePromptRun(activeMap, interruptedSet, sessionKey);
      }
    }
  } catch (err) {
    const error = deps.errorClassifiers.toError(err);
    if (hasAgentEndHooks) {
      const messages = Array.isArray(lastAgent?.messages) ? lastAgent?.messages : undefined;
      await hookRunner.runAgentEnd(
        {
          runId,
          success: false,
          error: error.message,
          durationMs: Math.max(0, Date.now() - startedAt),
          messages,
        },
        { sessionKey, agentId },
      );
    }
    agentEvents.emitLifecycle({
      runId,
      sessionKey,
      data: {
        phase: "error",
        startedAt,
        endedAt: Date.now(),
        error: error.message,
      },
    });
    throw err;
  } finally {
    deps.agentManager.clearRuntimeModelOverride(sessionKey);
  }

  if (hasAgentEndHooks) {
    const messages = Array.isArray(lastAgent?.messages) ? lastAgent?.messages : undefined;
    await hookRunner.runAgentEnd(
      {
        runId,
        success: true,
        durationMs: Math.max(0, Date.now() - startedAt),
        messages,
      },
      { sessionKey, agentId },
    );
  }

  agentEvents.emitLifecycle({
    runId,
    sessionKey,
    data: {
      phase: "end",
      startedAt,
      endedAt: Date.now(),
    },
  });
}

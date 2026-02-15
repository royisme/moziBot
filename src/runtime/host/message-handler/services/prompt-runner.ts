import { handleAgentStreamEvent, type AgentSessionEvent, type StreamingCallback } from "./streaming";

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
}

export interface PromptAgent {
  prompt(text: string): Promise<void> | void;
  abort?: () => Promise<void> | void;
  subscribe?: (listener: (event: unknown) => void) => () => void;
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
    getAgent(sessionKey: string, agentId: string): Promise<{ agent: PromptAgent; modelRef: string }>;
    getAgentFallbacks(agentId: string): string[];
    setSessionModel(sessionKey: string, modelRef: string, options: { persist: boolean }): Promise<void>;
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

/**
 * Registers an active prompt run in the bookkeeping maps.
 */
export function registerActivePromptRun(
  activeMap: Map<string, ActivePromptRun>,
  interruptedSet: Set<string>,
  params: { sessionKey: string } & ActivePromptRun
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
  sessionKey: string
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
  onStream?: StreamingCallback;
  onFallback?: (info: FallbackInfo) => Promise<void> | void;
  onContextOverflow?: (attempt: number) => Promise<void>;
  deps: PromptRunnerDeps;
  activeMap: Map<string, ActivePromptRun>;
  interruptedSet: Set<string>;
}): Promise<void> {
  const { sessionKey, agentId, text, onStream, onFallback, onContextOverflow, deps, activeMap, interruptedSet } = params;

  const fallbacks = deps.agentManager.getAgentFallbacks(agentId);
  const tried = new Set<string>();
  const transientRetryCounts = new Map<string, number>();
  let attempt = 0;
  let overflowCompactionAttempts = 0;
  const promptExecutionTimeoutMs = deps.agentManager.resolvePromptTimeoutMs(agentId);
  const promptProgressLogIntervalMs = 30_000;

  try {
    while (true) {
      const { agent, modelRef } = await deps.agentManager.getAgent(sessionKey, agentId);
      attempt += 1;
      const startedAt = Date.now();
      
      const progressTimer = setInterval(() => {
        deps.logger.warn(
          { sessionKey, agentId, modelRef, attempt, elapsedMs: Date.now() - startedAt, textChars: text.length },
          "Agent prompt still running"
        );
      }, promptProgressLogIntervalMs);

      let unsubscribe: (() => void) | undefined;
      let accumulatedText = "";
      
      try {
        registerActivePromptRun(activeMap, interruptedSet, {
          sessionKey,
          agentId,
          modelRef,
          startedAt,
          agent
        });

        if (onStream && typeof agent.subscribe === "function") {
          unsubscribe = agent.subscribe((event: unknown) => {
            const mapped = toStreamEvent(event);
            if (!mapped) {
              return;
            }
            void handleAgentStreamEvent(mapped, onStream, (delta) => {
              accumulatedText += delta;
            });
          });
        }

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

        const abortable = async <T>(promise: Promise<T>): Promise<T> => {
          const signal = runAbortController.signal;
          if (signal.aborted) {
            throw deps.errorClassifiers.toError(signal.reason ?? new Error("Agent prompt aborted"));
          }

          return await new Promise<T>((resolve, reject) => {
            const onAbort = () => {
              reject(deps.errorClassifiers.toError(signal.reason ?? new Error("Agent prompt aborted")));
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
          await abortable(Promise.resolve(agent.prompt(text)));
          
          if (onStream && accumulatedText) {
            await onStream({ type: "agent_end", fullText: accumulatedText });
          }
          break; // Success
        } finally {
          clearTimeout(timeoutHandle);
        }

      } catch (err) {
        const error = deps.errorClassifiers.toError(err);

        if (interruptedSet.has(sessionKey)) {
          const abortError = new Error("Interrupted by queue mode");
          abortError.name = "AbortError";
          throw abortError;
        }

        if (deps.errorClassifiers.isAgentBusyError(err)) {
          await waitForAgentIdle(agent);
          continue; // Retry busy current model
        }

        if (deps.errorClassifiers.isAbortError(error)) {
          throw error;
        }

        if (deps.errorClassifiers.isContextOverflowError(error.message) && onContextOverflow) {
          overflowCompactionAttempts++;
          await onContextOverflow(overflowCompactionAttempts);
          continue; // Retry overflow
        }

        // Transient error retry before fallback (exclude our own prompt timeout)
        const isSelfTimeout = error.message === "Agent prompt timeout";
        if (deps.errorClassifiers.isTransientError(error.message) && !isSelfTimeout) {
          const transientAttempts = transientRetryCounts.get(modelRef) ?? 0;
          if (transientAttempts < 2) {
            transientRetryCounts.set(modelRef, transientAttempts + 1);
            const delayMs = 1000 * 2 ** transientAttempts;
            deps.logger.warn(
              { sessionKey, agentId, modelRef, attempt, transientAttempts: transientAttempts + 1, delayMs },
              "Transient error, retrying current model after backoff",
            );
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
        }

        // Handle Fallback
        tried.add(modelRef);
        const nextModel = fallbacks.find(m => !tried.has(m));
        
        if (nextModel) {
          await deps.agentManager.setSessionModel(sessionKey, nextModel, { persist: false });
          if (onFallback) {
            await onFallback({
              fromModel: modelRef,
              toModel: nextModel,
              attempt: tried.size,
              error: error.message
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
  } finally {
    deps.agentManager.clearRuntimeModelOverride(sessionKey);
  }
}

import type { MoziConfig } from "../../config/schema";
import { AcpRuntimeError } from "../runtime/errors";
import { withAcpRuntimeErrorBoundary } from "../runtime/errors";
import {
  createIdentityFromEnsure,
  resolveSessionIdentityFromMeta,
} from "../runtime/session-identity";
import type {
  AcpRuntimeCapabilities,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeSessionMode,
  AcpRuntimeStatus,
} from "../runtime/types";
import type { SessionAcpMeta } from "../types";
import { reconcileManagerRuntimeSessionIdentifiers } from "./manager.identity-reconcile";
import { applyManagerRuntimeControls } from "./manager.runtime-controls";
import type {
  AcpCloseSessionInput,
  AcpCloseSessionResult,
  AcpInitializeSessionInput,
  AcpManagerObservabilitySnapshot,
  AcpRunTurnInput,
  AcpSessionManagerDeps,
  AcpSessionStatus,
  AcpStartupIdentityReconcileResult,
  ActiveTurnState,
  TurnLatencyStats,
} from "./manager.types";
import { DEFAULT_DEPS } from "./manager.types";
import {
  normalizeSessionKey,
  resolveAcpAgentFromSessionKey,
  resolveMissingMetaError,
} from "./manager.utils";
import { resolveRuntimeIdleTtlMs } from "./manager.utils";
import type { CachedRuntimeState } from "./runtime-cache";
import { RuntimeCache } from "./runtime-cache";
import {
  mergeRuntimeOptions,
  normalizeRuntimeOptions,
  resolveRuntimeOptionsFromMeta,
  validateRuntimeOptionPatch,
} from "./runtime-options";
import { SessionActorQueue } from "./session-actor-queue";

/**
 * Core ACP session manager that orchestrates session lifecycle,
 * runtime caching, and command queuing.
 */
export class AcpSessionManager {
  private readonly runtimeCache: RuntimeCache;
  private readonly actorQueue: SessionActorQueue;
  private readonly deps: AcpSessionManagerDeps;
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly turnStatsBySession = new Map<string, TurnLatencyStats>();
  private readonly errorsByCode = new Map<string, number>();
  private completedTurnsTotal = 0;
  private failedTurnsTotal = 0;

  constructor(deps: AcpSessionManagerDeps = DEFAULT_DEPS) {
    this.runtimeCache = new RuntimeCache();
    this.actorQueue = new SessionActorQueue();
    this.deps = deps;
  }

  /**
   * Initialize or resume an ACP session, returning a handle.
   */
  async ensureSession(input: AcpInitializeSessionInput): Promise<AcpRuntimeHandle> {
    const sessionKey = normalizeSessionKey(input.sessionKey);
    const agent = input.agent || resolveAcpAgentFromSessionKey(sessionKey);
    const mode: AcpRuntimeSessionMode = input.mode || "persistent";

    return this.actorQueue.run(sessionKey, async () =>
      this.ensureSessionWithinActor({
        input,
        sessionKey,
        agent,
        mode,
      }),
    );
  }

  private async ensureSessionWithinActor(params: {
    input: AcpInitializeSessionInput;
    sessionKey: string;
    agent: string;
    mode: AcpRuntimeSessionMode;
  }): Promise<AcpRuntimeHandle> {
    const { input, sessionKey, agent, mode } = params;

    // Check existing meta
    const entry = this.deps.readSessionEntry({
      sessionKey,
    });

    if (!entry?.acp) {
      throw resolveMissingMetaError(sessionKey);
    }

    const meta = entry.acp;
    const now = Date.now();

    // Get or create runtime instance
    let cached = this.runtimeCache.get(sessionKey);
    if (cached) {
      // Verify cached runtime is still valid
      const cachedIdentity = resolveSessionIdentityFromMeta(meta);
      const handleIdentifiersMatch =
        (!cachedIdentity?.acpxSessionId ||
          cached.handle.backendSessionId === cachedIdentity.acpxSessionId) &&
        (!cachedIdentity?.agentSessionId ||
          cached.handle.agentSessionId === cachedIdentity.agentSessionId);

      if (handleIdentifiersMatch) {
        this.runtimeCache.set(sessionKey, cached, { now });
        return cached.handle;
      }
      // Identity changed, clear cached runtime
      this.runtimeCache.clear(sessionKey);
      cached = null;
    }

    // Get backend runtime
    const backend = this.deps.requireRuntimeBackend(meta.backend);
    const runtime = backend.runtime;

    // Ensure session via runtime
    const handle = await withAcpRuntimeErrorBoundary({
      run: async () =>
        await runtime.ensureSession({
          sessionKey,
          agent,
          mode,
          cwd: input.cwd ?? meta.cwd,
        }),
      fallbackCode: "ACP_SESSION_INIT_FAILED",
      fallbackMessage: `Failed to ensure ACP session for ${sessionKey}.`,
    });

    // Create identity from ensure response
    const identityFromEnsure = createIdentityFromEnsure({
      handle,
      now,
    });

    // Merge identities
    const currentIdentity = resolveSessionIdentityFromMeta(meta);
    const mergedIdentity =
      currentIdentity || identityFromEnsure
        ? {
            state: "pending" as const,
            ...(identityFromEnsure?.acpxRecordId
              ? { acpxRecordId: identityFromEnsure.acpxRecordId }
              : {}),
            ...(identityFromEnsure?.acpxSessionId
              ? { acpxSessionId: identityFromEnsure.acpxSessionId }
              : {}),
            ...(identityFromEnsure?.agentSessionId
              ? { agentSessionId: identityFromEnsure.agentSessionId }
              : {}),
            source: "ensure" as const,
            lastUpdatedAt: now,
          }
        : undefined;

    // Update meta with new identity
    const updatedMeta = this.deps.upsertSessionMeta({
      sessionKey,
      mutate: (current) => {
        if (!current) {
          return null;
        }
        return {
          backend: current.backend,
          agent: current.agent,
          runtimeSessionName: current.runtimeSessionName,
          ...(mergedIdentity ? { identity: mergedIdentity } : {}),
          mode: current.mode,
          ...(current.runtimeOptions ? { runtimeOptions: current.runtimeOptions } : {}),
          ...(current.cwd ? { cwd: current.cwd } : {}),
          state: "idle" as const,
          lastActivityAt: now,
          ...(current.lastError ? { lastError: current.lastError } : {}),
        };
      },
    });

    if (!updatedMeta) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `Failed to persist ACP session meta for ${sessionKey}.`,
      );
    }

    // Cache the runtime instance
    const runtimeState: CachedRuntimeState = {
      runtime,
      handle,
      backend: meta.backend,
      agent,
      mode,
      cwd: input.cwd ?? meta.cwd,
    };
    this.runtimeCache.set(sessionKey, runtimeState, { now });

    return handle;
  }

  /**
   * Execute a turn with event streaming.
   */
  async runTurn(input: AcpRunTurnInput): Promise<void> {
    const sessionKey = normalizeSessionKey(input.sessionKey);
    const requestId = input.requestId || crypto.randomUUID();

    return this.actorQueue.run(sessionKey, async () => {
      const now = Date.now();
      const turnStart = Date.now();

      try {
        // Get session meta
        const entry = this.deps.readSessionEntry({ sessionKey });
        if (!entry?.acp) {
          throw resolveMissingMetaError(sessionKey);
        }
        const meta = entry.acp;

        // Get or create runtime
        let cached = this.runtimeCache.get(sessionKey, { touch: true, now });
        if (!cached) {
          await this.ensureSessionWithinActor({
            input: {
              cfg: input.cfg,
              sessionKey,
              agent: meta.agent,
              mode: meta.mode,
              cwd: meta.cwd,
            },
            sessionKey,
            agent: meta.agent,
            mode: meta.mode,
          });

          cached = this.runtimeCache.get(sessionKey, { now });
          if (!cached) {
            throw new AcpRuntimeError(
              "ACP_SESSION_INIT_FAILED",
              `Failed to initialize runtime for ${sessionKey}.`,
            );
          }
        }

        const { runtime, handle } = cached;

        // Apply runtime controls (options)
        await applyManagerRuntimeControls({
          sessionKey,
          runtime,
          handle,
          meta,
          getCachedRuntimeState: (sk) => this.runtimeCache.peek(sk),
        });

        // Update meta state to running
        this.deps.upsertSessionMeta({
          sessionKey,
          mutate: (current) => {
            if (!current) {
              return null;
            }
            return {
              ...current,
              state: "running" as const,
              lastActivityAt: now,
            };
          },
        });

        // Create abort controller
        const abortController = new AbortController();
        const signal = input.signal
          ? this.createLinkedSignal(abortController.signal, input.signal)
          : abortController.signal;

        // Track active turn
        const activeTurn: ActiveTurnState = {
          runtime,
          handle,
          abortController,
        };
        this.activeTurns.set(sessionKey, activeTurn);

        try {
          // Run the turn
          const turnInput = {
            handle,
            text: input.text,
            mode: input.mode,
            requestId,
            signal,
          };

          const events: AcpRuntimeEvent[] = [];
          let terminalSeen = false;
          for await (const event of runtime.runTurn(turnInput)) {
            if (terminalSeen) {
              continue;
            }
            events.push(event);
            if (input.onEvent) {
              await input.onEvent(event);
            }
            if (event.type === "done" || event.type === "error") {
              terminalSeen = true;
            }
          }

          // Update identity from final status if available
          if (runtime.getStatus) {
            try {
              const status = await runtime.getStatus({ handle });
              await reconcileManagerRuntimeSessionIdentifiers({
                cfg: input.cfg,
                sessionKey,
                runtime,
                handle,
                meta,
                runtimeStatus: status,
                failOnStatusError: false,
                setCachedHandle: (sk, h) => {
                  const c = this.runtimeCache.get(sk, { touch: false });
                  if (c) {
                    c.handle = h;
                  }
                },
                writeSessionMeta: async (params) => {
                  return this.deps.upsertSessionMeta({
                    sessionKey: params.sessionKey,
                    mutate: params.mutate,
                  });
                },
              });
            } catch (error) {
              console.debug(
                `acp-manager: failed to reconcile identity after turn for ${sessionKey}: ${String(error)}`,
              );
            }
          }

          // Update meta state to idle
          this.deps.upsertSessionMeta({
            sessionKey,
            mutate: (current) => {
              if (!current) {
                return null;
              }
              return {
                ...current,
                state: "idle" as const,
                lastActivityAt: Date.now(),
              };
            },
          });

          this.completedTurnsTotal++;

          // Update turn stats
          this.updateTurnStats(sessionKey, turnStart, false);
        } finally {
          this.activeTurns.delete(sessionKey);
        }
      } catch (error) {
        this.failedTurnsTotal++;

        // Track error by code
        if (error instanceof AcpRuntimeError) {
          const codeCount = this.errorsByCode.get(error.code) || 0;
          this.errorsByCode.set(error.code, codeCount + 1);
        }

        // Update meta state to error
        this.deps.upsertSessionMeta({
          sessionKey,
          mutate: (current) => {
            if (!current) {
              return null;
            }
            return {
              ...current,
              state: "error" as const,
              lastActivityAt: Date.now(),
              lastError: error instanceof Error ? error.message : String(error),
            };
          },
        });

        // Update turn stats
        this.updateTurnStats(sessionKey, turnStart, true);

        throw error;
      }
    });
  }

  /**
   * Close a session and cleanup.
   */
  async closeSession(input: AcpCloseSessionInput): Promise<AcpCloseSessionResult> {
    const sessionKey = normalizeSessionKey(input.sessionKey);
    const now = Date.now();

    return this.actorQueue.run(sessionKey, async () => {
      let runtimeClosed = false;
      let runtimeNotice: string | undefined;
      let metaCleared = false;

      try {
        // Get cached runtime
        const cached = this.runtimeCache.get(sessionKey, { touch: false });

        if (cached) {
          const { runtime, handle } = cached;

          // Cancel any active turn
          const activeTurn = this.activeTurns.get(sessionKey);
          if (activeTurn) {
            activeTurn.abortController.abort(input.reason);
          }

          // Close the runtime session
          try {
            await runtime.close({
              handle,
              reason: input.reason,
            });
            runtimeClosed = true;
          } catch (error) {
            if (!input.allowBackendUnavailable) {
              throw error;
            }
            runtimeNotice = `Backend close failed: ${String(error)}`;
          }

          // Clear from cache
          this.runtimeCache.clear(sessionKey);
        }

        // Clear meta if requested
        if (input.clearMeta) {
          this.deps.upsertSessionMeta({
            sessionKey,
            mutate: () => null,
          });
          metaCleared = true;
        } else {
          // Update meta state to idle
          this.deps.upsertSessionMeta({
            sessionKey,
            mutate: (current) => {
              if (!current) {
                return null;
              }
              return {
                ...current,
                state: "idle" as const,
                lastActivityAt: now,
              };
            },
          });
        }
      } catch (error) {
        if (!input.allowBackendUnavailable) {
          throw error;
        }
        runtimeNotice = `Close operation encountered error: ${String(error)}`;
      }

      return {
        runtimeClosed,
        runtimeNotice,
        metaCleared,
      };
    });
  }

  /**
   * Get current status of a session.
   */
  async getSessionStatus(sessionKey: string): Promise<AcpSessionStatus | null> {
    const normalizedKey = normalizeSessionKey(sessionKey);

    const entry = this.deps.readSessionEntry({ sessionKey: normalizedKey });
    if (!entry?.acp) {
      return null;
    }

    const meta = entry.acp;
    const cached = this.runtimeCache.get(normalizedKey, { touch: false });

    let runtimeStatus: AcpRuntimeStatus | undefined;
    let capabilities: AcpRuntimeCapabilities = { controls: [] };

    if (cached) {
      const { runtime, handle } = cached;

      // Get runtime status
      if (runtime.getStatus) {
        try {
          runtimeStatus = await runtime.getStatus({ handle });
        } catch (error) {
          console.debug(
            `acp-manager: failed to get runtime status for ${normalizedKey}: ${String(error)}`,
          );
        }
      }

      // Get capabilities
      if (runtime.getCapabilities) {
        try {
          capabilities = await runtime.getCapabilities({ handle });
        } catch (error) {
          console.debug(
            `acp-manager: failed to get runtime capabilities for ${normalizedKey}: ${String(error)}`,
          );
        }
      }
    }

    const runtimeOptions = resolveRuntimeOptionsFromMeta(meta);

    return {
      sessionKey: normalizedKey,
      backend: meta.backend,
      agent: meta.agent,
      identity: meta.identity,
      state: meta.state,
      mode: meta.mode,
      runtimeOptions,
      capabilities,
      runtimeStatus,
      lastActivityAt: meta.lastActivityAt,
      lastError: meta.lastError,
    };
  }

  /**
   * Perform startup identity reconciliation for all persisted sessions.
   */
  async reconcileIdentities(cfg: MoziConfig): Promise<AcpStartupIdentityReconcileResult> {
    const entries = this.deps.listAcpSessions();
    const result: AcpStartupIdentityReconcileResult = {
      checked: 0,
      resolved: 0,
      failed: 0,
    };

    for (const entry of entries) {
      const sessionKey = entry.sessionKey;
      const meta = entry.acp;

      if (!meta) {
        continue;
      }

      result.checked++;

      try {
        const backend = this.deps.requireRuntimeBackend(meta.backend);
        const runtime = backend.runtime;

        // Ensure session to get fresh handle
        const handle = await runtime.ensureSession({
          sessionKey,
          agent: meta.agent,
          mode: meta.mode,
          cwd: meta.cwd,
        });

        // Get status and reconcile identity
        if (runtime.getStatus) {
          const status = await runtime.getStatus({ handle });

          await reconcileManagerRuntimeSessionIdentifiers({
            cfg,
            sessionKey,
            runtime,
            handle,
            meta,
            runtimeStatus: status,
            failOnStatusError: false,
            setCachedHandle: (sk, h) => {
              const c = this.runtimeCache.get(sk, { touch: false });
              if (c) {
                c.handle = h;
              }
            },
            writeSessionMeta: async (params) => {
              return this.deps.upsertSessionMeta({
                sessionKey: params.sessionKey,
                mutate: params.mutate,
              });
            },
          });
        }

        // Cache the runtime instance for later use
        const now = Date.now();
        const runtimeState: CachedRuntimeState = {
          runtime,
          handle,
          backend: meta.backend,
          agent: meta.agent,
          mode: meta.mode,
          cwd: meta.cwd,
        };
        this.runtimeCache.set(sessionKey, runtimeState, { now });

        result.resolved++;
      } catch (error) {
        console.debug(
          `acp-manager: failed to reconcile identity for ${sessionKey}: ${String(error)}`,
        );
        result.failed++;
      }
    }

    return result;
  }

  /**
   * Get observability snapshot for monitoring.
   */
  getObservabilitySnapshot(): AcpManagerObservabilitySnapshot {
    const idleTtlMs = 0; // Would come from config
    const cacheSnapshot = this.runtimeCache.snapshot();

    return {
      runtimeCache: {
        activeSessions: cacheSnapshot.length,
        idleTtlMs,
        evictedTotal: 0,
      },
      turns: {
        active: this.activeTurns.size,
        queueDepth: this.actorQueue.getTotalPendingCount(),
        completed: this.completedTurnsTotal,
        failed: this.failedTurnsTotal,
        averageLatencyMs: this.computeAverageLatency(),
        maxLatencyMs: this.computeMaxLatency(),
      },
      errorsByCode: Object.fromEntries(this.errorsByCode),
    };
  }

  /**
   * Evict idle runtime instances based on TTL.
   */
  evictIdleRuntimes(cfg: MoziConfig): number {
    const idleTtlMs = resolveRuntimeIdleTtlMs(cfg);
    if (idleTtlMs <= 0) {
      return 0;
    }

    const now = Date.now();
    const idleCandidates = this.runtimeCache.collectIdleCandidates({
      maxIdleMs: idleTtlMs,
      now,
    });

    let evicted = 0;
    for (const candidate of idleCandidates) {
      // Check if there's an active turn
      if (this.activeTurns.has(candidate.actorKey)) {
        continue;
      }

      this.runtimeCache.clear(candidate.actorKey);
      evicted++;
    }

    return evicted;
  }

  /**
   * Update runtime options for a session.
   */
  async updateRuntimeOptions(
    sessionKey: string,
    patch: Partial<SessionAcpMeta["runtimeOptions"]>,
  ): Promise<void> {
    const normalizedKey = normalizeSessionKey(sessionKey);
    const now = Date.now();

    return this.actorQueue.run(normalizedKey, async () => {
      const entry = this.deps.readSessionEntry({ sessionKey: normalizedKey });
      if (!entry?.acp) {
        throw resolveMissingMetaError(normalizedKey);
      }

      const meta = entry.acp;
      const validatedPatch = validateRuntimeOptionPatch(patch);
      const mergedOptions = mergeRuntimeOptions({
        current: meta.runtimeOptions,
        patch: validatedPatch,
      });

      // Update meta
      this.deps.upsertSessionMeta({
        sessionKey: normalizedKey,
        mutate: (current) => {
          if (!current) {
            return null;
          }
          return {
            ...current,
            runtimeOptions: normalizeRuntimeOptions(mergedOptions),
            lastActivityAt: now,
          };
        },
      });

      // Apply to cached runtime if available
      const cached = this.runtimeCache.get(normalizedKey, { touch: false });
      if (cached) {
        await applyManagerRuntimeControls({
          sessionKey: normalizedKey,
          runtime: cached.runtime,
          handle: cached.handle,
          meta: {
            ...meta,
            runtimeOptions: mergedOptions,
          },
          getCachedRuntimeState: (sk) => this.runtimeCache.peek(sk),
        });
      }
    });
  }

  /**
   * Get active turn state for a session.
   */
  getActiveTurn(sessionKey: string): ActiveTurnState | undefined {
    return this.activeTurns.get(normalizeSessionKey(sessionKey));
  }

  /**
   * Cancel an active turn.
   */
  async cancelTurn(sessionKey: string, reason: string): Promise<boolean> {
    const normalizedKey = normalizeSessionKey(sessionKey);
    const activeTurn = this.activeTurns.get(normalizedKey);

    if (!activeTurn) {
      return false;
    }

    activeTurn.abortController.abort(reason);

    if (activeTurn.runtime.cancel && activeTurn.handle) {
      try {
        await activeTurn.runtime.cancel({
          handle: activeTurn.handle,
          reason,
        });
      } catch (error) {
        console.debug(`acp-manager: cancel failed for ${normalizedKey}: ${String(error)}`);
      }
    }

    return true;
  }

  private createLinkedSignal(signal1: AbortSignal, signal2: AbortSignal): AbortSignal {
    const controller = new AbortController();

    const abortHandler = () => {
      controller.abort();
    };

    if (signal1.aborted) {
      controller.abort();
    } else {
      signal1.addEventListener("abort", abortHandler, { once: true });
    }

    if (signal2.aborted) {
      controller.abort();
    } else {
      signal2.addEventListener("abort", abortHandler, { once: true });
    }

    return controller.signal;
  }

  private updateTurnStats(sessionKey: string, startMs: number, failed: boolean): void {
    const duration = Date.now() - startMs;
    let stats = this.turnStatsBySession.get(sessionKey);

    if (!stats) {
      stats = {
        completed: 0,
        failed: 0,
        totalMs: 0,
        maxMs: 0,
      };
      this.turnStatsBySession.set(sessionKey, stats);
    }

    if (failed) {
      stats.failed++;
    } else {
      stats.completed++;
    }

    stats.totalMs += duration;
    stats.maxMs = Math.max(stats.maxMs, duration);
  }

  private computeAverageLatency(): number {
    let totalCompleted = 0;
    let totalMs = 0;

    for (const stats of this.turnStatsBySession.values()) {
      totalCompleted += stats.completed;
      totalMs += stats.totalMs;
    }

    if (totalCompleted === 0) {
      return 0;
    }

    return Math.round(totalMs / totalCompleted);
  }

  private computeMaxLatency(): number {
    let maxMs = 0;
    for (const stats of this.turnStatsBySession.values()) {
      maxMs = Math.max(maxMs, stats.maxMs);
    }
    return maxMs;
  }
}

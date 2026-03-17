import fs from "node:fs";
import path from "node:path";
import { logger } from "../../../logger";
import { announceDetachedRun } from "./subagent-announce";

export type DetachedRunStatus =
  | "accepted"
  | "started"
  | "streaming"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

// Lifecycle phase type for async tasks
export type LifecyclePhase = DetachedRunStatus;

// Visibility policy for async tasks
export type VisibilityPolicy = "user_visible" | "internal_silent";

// Delivery phase status
export type DeliveryStatus = "none" | "pending" | "queued" | "sending" | "delivered" | "failed";

// Track which phases have been announced for deduplication
export type AnnouncedPhases = Record<DetachedRunStatus, boolean>;

// Delivery state for a specific phase (ack or terminal)
export interface DeliveryPhaseState {
  status: DeliveryStatus;
  deliveryEvidenceId?: string;
  queuedAt?: number;
  deliveredAt?: number;
  attemptCount: number;
  lastError?: string;
}

// Default delivery phase state (none = not applicable for this phase yet)
export function createDefaultDeliveryState(): DeliveryPhaseState {
  return {
    status: "none",
    attemptCount: 0,
  };
}

export interface DetachedRunRecord {
  runId: string;
  kind: "subagent" | "acp";
  childKey: string;
  parentKey: string;
  task: string;
  label?: string;
  cleanup: "delete" | "keep";
  status: DetachedRunStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  error?: string;
  announced?: boolean;
  announcedPhases?: AnnouncedPhases;
  timeoutSeconds?: number;
  // === Async Task Lifecycle extensions ===
  // Visibility policy - explicit user-facing vs internal
  visibilityPolicy?: VisibilityPolicy;
  // Origin metadata for delivery tracking
  originSessionKey?: string;
  originMessageId?: string;
  originChannelId?: string;
  originPeerId?: string;
  originThreadId?: string;
  // Delivery state tracking
  ackDelivery?: DeliveryPhaseState;
  terminalDelivery?: DeliveryPhaseState;
  // Phase that is pending delivery (distinct from lastDeliveredPhase which is authoritative)
  pendingDeliveryPhase?: LifecyclePhase;
  // Last phase that was actually delivered (authoritative)
  lastDeliveredPhase?: LifecyclePhase;
  // Retry metadata
  retryCount?: number;
  nextRetryAt?: number;
  lastDeliveryError?: string;
  // Terminal summary (for delivery)
  terminalSummary?: string;
  abortRequestedAt?: number;
  abortRequestedBy?: string;
  staleDetectedAt?: number;
}

// Extended registration options with lifecycle fields
export interface DetachedRunRegistrationOptions {
  runId: string;
  kind: "subagent" | "acp";
  childKey: string;
  parentKey: string;
  task: string;
  label?: string;
  cleanup: "delete" | "keep";
  timeoutSeconds?: number;
  // Lifecycle extensions
  visibilityPolicy: VisibilityPolicy;
  originSessionKey?: string;
  originMessageId?: string;
  originChannelId?: string;
  originPeerId?: string;
  originThreadId?: string;
}

export class DetachedRunRegistry {
  private runs: Map<string, DetachedRunRecord> = new Map();
  private persistPath: string;
  private sweepInterval: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.persistPath = path.join(dataDir, "subagent-runs.json");
    this.restore();
    this.startSweeper();
  }

  register(
    run: Omit<
      DetachedRunRecord,
      "createdAt" | "status" | "kind" | "announcedPhases" | "ackDelivery" | "terminalDelivery"
    > & {
      kind?: "subagent" | "acp";
      createdAt?: number;
      status?: DetachedRunStatus;
    },
  ): void {
    const record: DetachedRunRecord = {
      ...run,
      kind: run.kind ?? "subagent",
      createdAt: run.createdAt ?? Date.now(),
      status: run.status ?? "accepted",
      announcedPhases: {
        accepted: false,
        started: false,
        streaming: false,
        completed: false,
        failed: false,
        aborted: false,
        timeout: false,
      },
      // Initialize delivery state for authoritative lifecycle tracking
      // ackDelivery starts as pending (needs initial ack delivery)
      ackDelivery: { ...createDefaultDeliveryState(), status: "pending" },
      // terminalDelivery starts as "none" - not applicable until terminal
      terminalDelivery: createDefaultDeliveryState(),
      retryCount: 0,
    };
    this.runs.set(record.runId, record);
    this.persist();

    // Skip "accepted" announcement — "started" follows almost immediately and is sufficient.
    // Mark ackDelivery as delivered to prevent lifecycle guard issues.
    if (record.ackDelivery) {
      record.ackDelivery.status = "delivered";
      record.ackDelivery.deliveredAt = record.createdAt;
    }
    if (record.announcedPhases) {
      record.announcedPhases.accepted = true;
    }
    record.lastDeliveredPhase = "accepted";
    this.persist();
  }

  // === Lifecycle Phase Transition Methods ===

  /**
   * Validates if a lifecycle transition is allowed.
   * Returns true if the transition is valid.
   */
  canTransition(fromPhase: LifecyclePhase, toPhase: LifecyclePhase): boolean {
    const terminalPhases: LifecyclePhase[] = ["completed", "failed", "timeout", "aborted"];

    // Terminal phases cannot transition
    if (terminalPhases.includes(fromPhase)) {
      return false;
    }

    // Valid transitions (including self-transition for idempotency)
    const validTransitions: Record<LifecyclePhase, LifecyclePhase[]> = {
      accepted: ["accepted", "started", "streaming", "completed", "failed", "timeout", "aborted"],
      started: ["started", "streaming", "completed", "failed", "timeout", "aborted"],
      streaming: ["streaming", "completed", "failed", "timeout", "aborted"],
      completed: ["completed"],
      failed: ["failed"],
      timeout: ["timeout"],
      aborted: ["aborted"],
    };

    return validTransitions[fromPhase]?.includes(toPhase) ?? false;
  }

  /**
   * Transition to a new lifecycle phase with validation.
   * Returns the updated record or undefined if transition is invalid.
   */
  transitionTo(
    runId: string,
    newPhase: LifecyclePhase,
    options?: {
      result?: string;
      error?: string;
      timestamp?: number;
    },
  ): DetachedRunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }

    if (!this.canTransition(run.status, newPhase)) {
      logger.warn(
        { runId, currentPhase: run.status, requestedPhase: newPhase },
        "Invalid lifecycle transition attempted",
      );
      return undefined;
    }

    const now = options?.timestamp ?? Date.now();
    const isTerminal = ["completed", "failed", "timeout", "aborted"].includes(newPhase);

    // Update record based on phase
    if (newPhase === "started") {
      run.status = "started";
      run.startedAt = now;
    } else if (newPhase === "streaming") {
      run.status = "streaming";
      if (!run.startedAt) {
        run.startedAt = now;
      }
    } else if (isTerminal) {
      run.status = newPhase as DetachedRunStatus;
      run.endedAt = options?.timestamp ?? now;
      run.result = options?.result;
      run.error = options?.error;
    } else {
      run.status = newPhase as DetachedRunStatus;
    }

    // Update delivery state based on phase
    if (newPhase === "accepted") {
      if (run.ackDelivery) {
        run.ackDelivery.status = "pending";
      }
    } else if (isTerminal) {
      if (run.terminalDelivery) {
        run.terminalDelivery.status = "pending";
      }
      // Track phase pending delivery (not yet delivered)
      run.pendingDeliveryPhase = newPhase;
      // Note: lastDeliveredPhase is only updated after actual delivery
    }

    this.persist();
    return run;
  }

  /**
   * Check if a phase has already been delivered (for dedupe).
   */
  isPhaseDelivered(runId: string, phase: LifecyclePhase): boolean {
    const run = this.runs.get(runId);
    if (!run || !run.announcedPhases) {
      return false;
    }
    return run.announcedPhases[phase as DetachedRunStatus] ?? false;
  }

  /**
   * Mark a phase as delivered (for dedupe tracking).
   */
  markPhaseDelivered(runId: string, phase: LifecyclePhase): void {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    if (!run.announcedPhases) {
      run.announcedPhases = {
        accepted: false,
        started: false,
        streaming: false,
        completed: false,
        failed: false,
        aborted: false,
        timeout: false,
      };
    }
    run.announcedPhases[phase as DetachedRunStatus] = true;
    run.lastDeliveredPhase = phase;
    this.persist();
  }

  /**
   * Update delivery state for ack or terminal phase.
   */
  updateDeliveryState(
    runId: string,
    phase: "ack" | "terminal",
    state: Partial<DeliveryPhaseState>,
  ): void {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }

    const deliveryState = phase === "ack" ? run.ackDelivery : run.terminalDelivery;
    if (deliveryState) {
      Object.assign(deliveryState, state);
      if (state.status === "delivered" && !deliveryState.deliveredAt) {
        deliveryState.deliveredAt = Date.now();
      }
      if (state.status === "queued" && !deliveryState.queuedAt) {
        deliveryState.queuedAt = Date.now();
      }
    }

    this.persist();
  }

  /**
   * Get delivery state for a phase.
   */
  getDeliveryState(runId: string, phase: "ack" | "terminal"): DeliveryPhaseState | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    return phase === "ack" ? run.ackDelivery : run.terminalDelivery;
  }

  /**
   * Check if a run is user-visible based on visibility policy.
   */
  isUserVisible(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) {
      return false;
    }
    // Default to user_visible if not explicitly set
    return run.visibilityPolicy !== "internal_silent";
  }

  /**
   * Set visibility policy for a run.
   */
  setVisibilityPolicy(runId: string, policy: VisibilityPolicy): void {
    const run = this.runs.get(runId);
    if (run) {
      run.visibilityPolicy = policy;
      this.persist();
    }
  }

  /**
   * Check if any user-visible lifecycle delivery is still pending for a parent session.
   * This is used to determine if NO_REPLY should be suppressed in the parent turn.
   *
   * Despite the legacy ack-oriented method name, this includes both:
   * - active runs whose initial acknowledgement has not been delivered yet, and
   * - terminal runs whose terminal lifecycle delivery has not been delivered yet.
   *
   * Returns: { hasPendingUserVisible: boolean, pendingRunIds: string[] }
   */
  getPendingUserVisibleAck(parentKey: string): {
    hasPendingUserVisible: boolean;
    pendingRunIds: string[];
  } {
    const runs = this.listByParent(parentKey);
    const pending: string[] = [];

    for (const run of runs) {
      if (run.visibilityPolicy === "internal_silent") {
        continue;
      }

      const ackDelivered = run.ackDelivery?.status === "delivered";
      const terminalDelivered = run.terminalDelivery?.status === "delivered";
      const isTerminal = ["completed", "failed", "timeout", "aborted"].includes(run.status);

      if (!ackDelivered || (isTerminal && !terminalDelivered)) {
        pending.push(run.runId);
      }
    }

    return {
      hasPendingUserVisible: pending.length > 0,
      pendingRunIds: pending,
    };
  }

  /**
   * Check if a specific run needs acknowledgement delivery.
   */
  needsAckDelivery(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) {
      return false;
    }
    // Check if it's user-visible and ack hasn't been delivered
    return run.visibilityPolicy !== "internal_silent" && run.ackDelivery?.status !== "delivered";
  }

  /**
   * Check if acknowledgement is satisfied (delivered) for a run.
   */
  isAckDelivered(runId: string): boolean {
    const run = this.runs.get(runId);
    return run?.ackDelivery?.status === "delivered";
  }

  get(runId: string): DetachedRunRecord | undefined {
    return this.runs.get(runId);
  }

  getByChildKey(childKey: string): DetachedRunRecord | undefined {
    return [...this.runs.values()].find((r) => r.childKey === childKey);
  }

  listByParent(parentKey: string): DetachedRunRecord[] {
    return [...this.runs.values()]
      .filter((r) => r.parentKey === parentKey)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  listAll(): DetachedRunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  listActiveByParent(parentKey: string): DetachedRunRecord[] {
    return this.listByParent(parentKey).filter(
      (r) => !["completed", "failed", "aborted", "timeout"].includes(r.status),
    );
  }

  listActive(): DetachedRunRecord[] {
    return [...this.runs.values()]
      .filter((r) => !["completed", "failed", "aborted", "timeout"].includes(r.status))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  cleanTerminal(parentKey?: string): { cleaned: number; runIds: string[] } {
    const terminalStatuses = ["completed", "failed", "aborted", "timeout"];
    const runIds: string[] = [];
    for (const [id, run] of this.runs) {
      if (!terminalStatuses.includes(run.status)) {
        continue;
      }
      if (parentKey && run.parentKey !== parentKey) {
        continue;
      }
      runIds.push(id);
    }
    for (const id of runIds) {
      this.runs.delete(id);
    }
    if (runIds.length > 0) {
      this.persist();
    }
    return { cleaned: runIds.length, runIds };
  }

  update(runId: string, changes: Partial<DetachedRunRecord>): DetachedRunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    Object.assign(run, changes);
    this.persist();
    return run;
  }

  markAbortRequested(
    runId: string,
    requestedBy: string,
    requestedAt = Date.now(),
  ): DetachedRunRecord | undefined {
    return this.update(runId, {
      abortRequestedAt: requestedAt,
      abortRequestedBy: requestedBy,
    });
  }

  markStaleDetected(runId: string, detectedAt = Date.now()): DetachedRunRecord | undefined {
    return this.update(runId, {
      staleDetectedAt: detectedAt,
    });
  }

  markStarted(runId: string, startedAt = Date.now()): DetachedRunRecord | undefined {
    const run = this.transitionTo(runId, "started", { timestamp: startedAt });
    if (run) {
      this.triggerPhaseAnnounce(run, "started").catch((err) => {
        logger.error({ err, runId }, "Failed to announce started phase");
      });
    }
    return run;
  }

  markStreaming(runId: string, startedAt?: number): DetachedRunRecord | undefined {
    const run = this.transitionTo(runId, "streaming", {
      timestamp: startedAt ?? Date.now(),
    });
    // Skip "streaming" announcement — users don't need "producing output" notifications.
    return run;
  }

  // Trigger announcement for a specific phase (non-terminal)
  async triggerPhaseAnnounce(
    run: DetachedRunRecord,
    phase: "accepted" | "started" | "streaming",
  ): Promise<void> {
    const phases = run.announcedPhases;
    if (!phases || phases[phase]) {
      return;
    }

    const announced = await announceDetachedRun({
      runId: run.runId,
      childKey: run.childKey,
      parentKey: run.parentKey,
      task: run.task,
      label: run.label,
      kind: run.kind,
      status: phase,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    });
    if (!announced) {
      return;
    }

    phases[phase] = true;

    // Update delivery state to delivered after successful announce
    if (phase === "accepted" && run.ackDelivery) {
      run.ackDelivery.status = "delivered";
      run.ackDelivery.deliveredAt = Date.now();
    }
    // Update lastDeliveredPhase after successful delivery
    run.lastDeliveredPhase = phase;

    this.persist();
  }

  async setTerminal(params: {
    runId: string;
    status: "completed" | "failed" | "aborted" | "timeout";
    result?: string;
    error?: string;
    endedAt?: number;
  }): Promise<DetachedRunRecord | undefined> {
    const run = this.runs.get(params.runId);
    if (!run) {
      return undefined;
    }
    const terminalStatus = params.status;
    const phases = run.announcedPhases;
    if (phases && phases[terminalStatus]) {
      return run; // Already announced this terminal phase - still update delivery state
    }

    // Save previous state for rollback
    const previousStatus = run.status;
    const previousResult = run.result;
    const previousError = run.error;
    const previousEndedAt = run.endedAt;
    const previousTerminalDelivery = run.terminalDelivery ? { ...run.terminalDelivery } : undefined;
    const previousLastDeliveredPhase = run.lastDeliveredPhase;

    // Update the run state
    run.status = params.status;
    run.result = params.result;
    run.error = params.error;
    run.endedAt = params.endedAt ?? Date.now();

    // Update terminal delivery state to pending
    if (run.terminalDelivery) {
      run.terminalDelivery.status = "pending";
    }
    // Track phase pending delivery (not yet delivered)
    run.pendingDeliveryPhase = terminalStatus;
    // Note: lastDeliveredPhase is only updated after actual delivery in triggerAnnounce

    // Persist with rollback on failure
    try {
      this.persist();
    } catch (error) {
      // Restore previous state on persistence failure
      run.status = previousStatus;
      run.result = previousResult;
      run.error = previousError;
      run.endedAt = previousEndedAt;
      run.terminalDelivery = previousTerminalDelivery;
      run.lastDeliveredPhase = previousLastDeliveredPhase;
      throw error;
    }

    await this.triggerAnnounce(run, terminalStatus);
    return run;
  }

  async completeByChildKey(
    childKey: string,
    result: {
      status: "completed" | "failed" | "aborted" | "timeout";
      result?: string;
      error?: string;
    },
  ): Promise<void> {
    const run = this.getByChildKey(childKey);
    if (!run) {
      return;
    }
    await this.setTerminal({ runId: run.runId, ...result });
  }

  private async triggerAnnounce(
    run: DetachedRunRecord,
    terminalStatus: "completed" | "failed" | "aborted" | "timeout",
  ): Promise<void> {
    const phases = run.announcedPhases;
    if (!phases) {
      run.announcedPhases = {
        accepted: false,
        started: false,
        streaming: false,
        completed: false,
        failed: false,
        aborted: false,
        timeout: false,
      };
    }

    if (phases?.[terminalStatus]) {
      return; // Already announced
    }

    try {
      const announced = await announceDetachedRun({
        runId: run.runId,
        childKey: run.childKey,
        parentKey: run.parentKey,
        task: run.task,
        label: run.label,
        kind: run.kind,
        status: terminalStatus,
        result: run.result,
        error: run.error,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      });
      if (!announced) {
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, runId: run.runId }, "Failed to announce detached run result");
      return;
    }

    // Mark terminal phase as announced
    if (run.announcedPhases) {
      run.announcedPhases[terminalStatus] = true;
    }
    run.announced = true;

    // Update delivery state to delivered (authoritative)
    if (run.terminalDelivery) {
      run.terminalDelivery.status = "delivered";
      run.terminalDelivery.deliveredAt = Date.now();
    }
    // Update lastDeliveredPhase to reflect actual delivery (authoritative)
    run.lastDeliveredPhase = terminalStatus;
    // Clear pending delivery phase
    run.pendingDeliveryPhase = undefined;

    this.persist();

    if (run.cleanup === "delete") {
      this.runs.delete(run.runId);
      this.persist();
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
    const data = Object.fromEntries(this.runs);
    fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
  }

  private restore(): void {
    try {
      if (!fs.existsSync(this.persistPath)) {
        return;
      }
      const data = JSON.parse(fs.readFileSync(this.persistPath, "utf-8"));
      for (const [id, record] of Object.entries(data)) {
        const restored = record as Partial<DetachedRunRecord>;
        // Ensure delivery state is initialized for records restored from older format
        const ackDelivery = restored.ackDelivery ?? createDefaultDeliveryState();
        const terminalDelivery = restored.terminalDelivery ?? createDefaultDeliveryState();

        this.runs.set(id, {
          ...restored,
          runId: restored.runId ?? id,
          kind: restored.kind ?? "subagent",
          childKey: restored.childKey ?? "",
          parentKey: restored.parentKey ?? "",
          task: restored.task ?? "",
          cleanup: restored.cleanup ?? "keep",
          status: restored.status ?? "accepted",
          createdAt: restored.createdAt ?? Date.now(),
          // Ensure lifecycle extensions are present
          visibilityPolicy: restored.visibilityPolicy,
          ackDelivery,
          terminalDelivery,
          retryCount: restored.retryCount ?? 0,
          // Ensure announcedPhases exists
          announcedPhases: restored.announcedPhases ?? {
            accepted: false,
            started: false,
            streaming: false,
            completed: false,
            failed: false,
            aborted: false,
            timeout: false,
          },
        } as DetachedRunRecord);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, "Failed to restore detached run registry");
    }
  }

  /**
   * Serialize all runs to JSON for external persistence.
   */
  serialize(): Record<string, DetachedRunRecord> {
    return Object.fromEntries(this.runs);
  }

  /**
   * Restore runs from serialized data (for advanced recovery scenarios).
   */
  restoreFromSerialized(data: Record<string, DetachedRunRecord>): void {
    for (const [id, record] of Object.entries(data)) {
      // Ensure delivery state is initialized
      if (!record.ackDelivery) {
        record.ackDelivery = createDefaultDeliveryState();
      }
      if (!record.terminalDelivery) {
        record.terminalDelivery = createDefaultDeliveryState();
      }
      if (!record.announcedPhases) {
        record.announcedPhases = {
          accepted: false,
          started: false,
          streaming: false,
          completed: false,
          failed: false,
          aborted: false,
          timeout: false,
        };
      }
      this.runs.set(id, record);
    }
    this.persist();
  }

  /**
   * Get all runs with pending delivery (for replay).
   * Note: terminal delivery only counts as pending for terminal runs.
   */
  getRunsWithPendingDelivery(): DetachedRunRecord[] {
    const terminalPhases: DetachedRunStatus[] = ["completed", "failed", "timeout", "aborted"];
    return [...this.runs.values()].filter((run) => {
      const ackPending =
        run.ackDelivery?.status === "pending" || run.ackDelivery?.status === "queued";
      // Only count terminal delivery as pending for actual terminal runs
      const isTerminal = terminalPhases.includes(run.status);
      const terminalPending =
        isTerminal &&
        (run.terminalDelivery?.status === "pending" ||
          run.terminalDelivery?.status === "queued" ||
          run.terminalDelivery?.status === "failed");
      return ackPending || terminalPending;
    });
  }

  /**
   * Get terminal runs that haven't been delivered yet (for replay).
   */
  getUndeliveredTerminalRuns(): DetachedRunRecord[] {
    const terminalPhases: DetachedRunStatus[] = ["completed", "failed", "timeout", "aborted"];
    return [...this.runs.values()].filter((run) => {
      if (!terminalPhases.includes(run.status)) {
        return false;
      }
      // Check if terminal delivery is not delivered
      return run.terminalDelivery?.status !== "delivered";
    });
  }

  private startSweeper(): void {
    const sweepMs = 5 * 60 * 1000;
    this.sweepInterval = setInterval(() => {
      const cutoff = Date.now() - 60 * 60 * 1000;
      let swept = 0;
      for (const [id, run] of this.runs) {
        if (run.announced && run.endedAt && run.endedAt < cutoff) {
          this.runs.delete(id);
          swept += 1;
        }
      }
      if (swept > 0) {
        this.persist();
      }
    }, sweepMs);
    this.sweepInterval.unref?.();
  }

  async reconcileOrphanedRuns(options?: {
    parentKey?: string;
    isRunActive?: (runId: string) => boolean;
    requestedBy?: string;
  }): Promise<{
    retried: number;
    retriedAck: number;
    reconciled: number;
    runIds: string[];
    retriedAckRunIds: string[];
  }> {
    const terminalPhases: DetachedRunStatus[] = ["completed", "failed", "timeout", "aborted"];
    const scopedRuns = [...this.runs.values()].filter((run) =>
      options?.parentKey ? run.parentKey === options.parentKey : true,
    );
    let retried = 0;
    let retriedAck = 0;
    let reconciled = 0;
    const runIds: string[] = [];
    const retriedAckRunIds: string[] = [];

    const pendingAnnouncementRuns = scopedRuns.filter(
      (run) =>
        !run.announced &&
        terminalPhases.includes(run.status) &&
        run.terminalDelivery?.status !== "delivered",
    );

    for (const run of pendingAnnouncementRuns) {
      logger.warn(
        { runId: run.runId, childKey: run.childKey, kind: run.kind, status: run.status },
        "Retrying pending detached task completion announcement after host restart",
      );
      if (run.terminalDelivery) {
        run.terminalDelivery.status = "pending";
        run.terminalDelivery.attemptCount += 1;
      }
      await this.triggerAnnounce(run, run.status as "completed" | "failed" | "aborted" | "timeout");
      retried += 1;
      runIds.push(run.runId);
    }

    const pendingAckRuns = scopedRuns.filter((run) => {
      if (run.visibilityPolicy === "internal_silent") {
        return false;
      }
      return run.ackDelivery?.status === "pending";
    });

    for (const run of pendingAckRuns) {
      try {
        logger.warn(
          { runId: run.runId, childKey: run.childKey, kind: run.kind, status: run.status },
          "Retrying pending detached task acknowledgement after host restart",
        );
        if (run.ackDelivery) {
          run.ackDelivery.attemptCount += 1;
        }
        this.persist();
        await this.triggerPhaseAnnounce(run, "accepted");
        retriedAck += 1;
        retriedAckRunIds.push(run.runId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          { err: message, runId: run.runId },
          "Ack delivery retry failed, will retry on next reconciliation",
        );
        if (run.ackDelivery) {
          run.ackDelivery.lastError = message;
        }
        this.persist();
      }
    }

    const orphanedRuns = scopedRuns.filter((run) => {
      if (run.announced || terminalPhases.includes(run.status)) {
        return false;
      }
      if (!options?.isRunActive) {
        return true;
      }
      return !options.isRunActive(run.runId);
    });

    for (const run of orphanedRuns) {
      const now = Date.now();
      run.staleDetectedAt = now;
      if (options?.requestedBy) {
        run.abortRequestedAt = now;
        run.abortRequestedBy = options.requestedBy;
      }
      this.persist();
      if (options?.isRunActive) {
        logger.warn(
          { runId: run.runId, childKey: run.childKey, kind: run.kind, status: run.status },
          "Marking detached task run as aborted after stale runtime handle detection",
        );
        await this.setTerminal({
          runId: run.runId,
          status: "aborted",
          error: "Reconciled orphaned run: no active runtime handle",
        });
      } else {
        logger.warn(
          { runId: run.runId, childKey: run.childKey, kind: run.kind, status: run.status },
          "Marking orphaned detached task run as failed after host restart",
        );
        await this.setTerminal({
          runId: run.runId,
          status: "failed",
          error: "Host restarted while run was in progress",
        });
      }
      reconciled += 1;
      runIds.push(run.runId);
    }

    return { retried, retriedAck, reconciled, runIds, retriedAckRunIds };
  }

  /**
   * Validate that no user-visible task reaches terminal state without delivery evidence.
   * This is a critical invariant: every terminal user-visible task must have either:
   * - delivered terminal delivery, OR
   * - pending/queued/failed terminal delivery (meaning it's queued for retry)
   *
   * Returns validation result with any violations found.
   */
  validateNoBlackHoleTasks(): {
    isValid: boolean;
    violations: Array<{
      runId: string;
      status: string;
      visibilityPolicy: string;
      terminalDeliveryStatus: string | undefined;
      issue: string;
    }>;
  } {
    const terminalPhases: DetachedRunStatus[] = ["completed", "failed", "timeout", "aborted"];
    const violations: Array<{
      runId: string;
      status: string;
      visibilityPolicy: string;
      terminalDeliveryStatus: string | undefined;
      issue: string;
    }> = [];

    for (const run of this.runs.values()) {
      // Only check terminal user-visible runs
      if (!terminalPhases.includes(run.status)) {
        continue;
      }

      if (run.visibilityPolicy === "internal_silent") {
        continue; // Internal tasks don't need user delivery
      }

      const terminalStatus = run.terminalDelivery?.status;

      // Violation: terminal run without any delivery evidence
      if (!terminalStatus || terminalStatus === "none") {
        violations.push({
          runId: run.runId,
          status: run.status,
          visibilityPolicy: run.visibilityPolicy ?? "user_visible",
          terminalDeliveryStatus: terminalStatus,
          issue: "Terminal user-visible task has no delivery state",
        });
      }
      // Violation: terminal run that was attempted but not delivered and not pending retry
      else if (
        terminalStatus !== "delivered" &&
        terminalStatus !== "pending" &&
        terminalStatus !== "queued"
      ) {
        violations.push({
          runId: run.runId,
          status: run.status,
          visibilityPolicy: run.visibilityPolicy ?? "user_visible",
          terminalDeliveryStatus: terminalStatus,
          issue: `Terminal user-visible task has terminal delivery status: ${terminalStatus}`,
        });
      }
    }

    return {
      isValid: violations.length === 0,
      violations,
    };
  }

  /**
   * Get all runs that need replay on restart (pending ack or undelivered terminal).
   * This helps with startup reconciliation diagnostics.
   */
  getRunsNeedingReplay(): {
    pendingAck: DetachedRunRecord[];
    undeliveredTerminal: DetachedRunRecord[];
  } {
    const pendingAck = this.getRunsWithPendingDelivery().filter((run) => {
      // For active runs, check if ack is pending
      const terminalPhases: DetachedRunStatus[] = ["completed", "failed", "timeout", "aborted"];
      return !terminalPhases.includes(run.status) && run.ackDelivery?.status === "pending";
    });

    const undeliveredTerminal = this.getUndeliveredTerminalRuns();

    return {
      pendingAck,
      undeliveredTerminal,
    };
  }

  shutdown(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    this.persist();
  }
}

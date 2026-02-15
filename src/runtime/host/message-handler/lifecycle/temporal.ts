/**
 * Temporal Lifecycle Pure Functions
 *
 * This module contains pure logic for time-based session rotation.
 * It is decoupled from the runtime host and class instances.
 */

export interface TemporalLifecyclePolicy {
  readonly enabled: boolean;
  readonly activeWindowHours: number;
  readonly dayBoundaryRollover: boolean;
}

export interface SessionTimestamps {
  readonly createdAt: number;
  readonly updatedAt?: number;
}

/**
 * Checks if two timestamps fall on the same local calendar day.
 */
export function isSameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Resolves the temporal lifecycle policy for a specific agent.
 * Merges agent-specific overrides with system defaults.
 */
export function resolveTemporalLifecyclePolicy(
  agentId: string,
  configAgents: Record<string, unknown> | undefined,
): TemporalLifecyclePolicy {
  const agents = configAgents || {};

  // Extract defaults from config
  const defaults = (
    agents.defaults as { lifecycle?: { temporal?: Partial<TemporalLifecyclePolicy> } } | undefined
  )?.lifecycle?.temporal;

  // Extract agent-specific entry
  const entry = (
    agents[agentId] as { lifecycle?: { temporal?: Partial<TemporalLifecyclePolicy> } } | undefined
  )?.lifecycle?.temporal;

  return {
    enabled: entry?.enabled ?? defaults?.enabled ?? true,
    activeWindowHours: entry?.activeWindowHours ?? defaults?.activeWindowHours ?? 12,
    dayBoundaryRollover: entry?.dayBoundaryRollover ?? defaults?.dayBoundaryRollover ?? true,
  };
}

/**
 * Determines if a session should be rotated based on the temporal policy.
 * This is a pure function that requires explicit policy and session state.
 */
export function shouldRotateSessionForTemporalPolicy(
  policy: TemporalLifecyclePolicy,
  session: SessionTimestamps,
  nowMs: number = Date.now(),
): boolean {
  if (!policy.enabled) {
    return false;
  }

  const lastActivityMs = session.updatedAt || session.createdAt;
  const activeWindowMs = Math.max(1, policy.activeWindowHours) * 60 * 60 * 1000;

  // 1. Check if the activity window has expired
  if (nowMs - lastActivityMs > activeWindowMs) {
    return true;
  }

  // 2. Check if we crossed a local day boundary
  if (policy.dayBoundaryRollover && !isSameLocalDay(lastActivityMs, nowMs)) {
    return true;
  }

  return false;
}

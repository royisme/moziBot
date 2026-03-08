/**
 * Governance pipeline configuration surface.
 *
 * All fields have safe defaults so the module works without explicit user config.
 */

export interface GovernanceConfig {
  /** Master switch – when false the governed pipeline is bypassed entirely. */
  enabled: boolean;

  // ---------------------------------------------------------------------------
  // Extraction triggers
  // ---------------------------------------------------------------------------
  extractOnTurnCompleted: boolean;
  extractOnBeforeReset: boolean;
  extractOnPreCompact: boolean;

  // ---------------------------------------------------------------------------
  // Quality thresholds
  // ---------------------------------------------------------------------------
  /** Minimum confidence (0–1) for a candidate to pass the policy engine. */
  minConfidence: number;

  /** Score threshold for automatic promotion to long-term memory. */
  promotionScoreThreshold: number;

  /** Whether a candidate with `user_explicit` evidence auto-promotes without threshold check. */
  autoPromoteOnUserExplicit: boolean;

  // ---------------------------------------------------------------------------
  // Recurrence detection
  // ---------------------------------------------------------------------------
  /**
   * How many days to look back when counting recurrence for a dedupe family.
   * If a dedupe family appears >= recurrenceCountThreshold times within this
   * window the candidate becomes eligible for promotion.
   */
  recurrenceWindowDays: number;
  recurrenceCountThreshold: number;

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------
  /** Debounce interval (ms) before triggering the daily compiler after new candidates arrive. */
  dailyCompilerDebounceMs: number;

  /** Whether the maintenance job runs automatically on lifecycle events. */
  maintenanceAutoRun: boolean;
}

// ---------------------------------------------------------------------------
// Safe defaults
// ---------------------------------------------------------------------------

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = {
  enabled: true,

  extractOnTurnCompleted: true,
  extractOnBeforeReset: true,
  extractOnPreCompact: true,

  minConfidence: 0.5,

  promotionScoreThreshold: 4,
  autoPromoteOnUserExplicit: true,

  recurrenceWindowDays: 7,
  recurrenceCountThreshold: 3,

  dailyCompilerDebounceMs: 5_000,

  maintenanceAutoRun: false,
};

/**
 * Merge a partial user config over the safe defaults.
 */
export function resolveGovernanceConfig(partial?: Partial<GovernanceConfig>): GovernanceConfig {
  if (!partial) {
    return { ...DEFAULT_GOVERNANCE_CONFIG };
  }
  return { ...DEFAULT_GOVERNANCE_CONFIG, ...partial };
}

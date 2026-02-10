/**
 * Context pruning configuration and settings.
 *
 * Based on OpenClaw's context-pruning approach but simplified for Mozi.
 */

export type ContextPruningConfig = {
  enabled?: boolean;
  /** Ratio of context window at which soft trimming starts (default: 0.5) */
  softTrimRatio?: number;
  /** Ratio of context window at which hard clearing starts (default: 0.7) */
  hardClearRatio?: number;
  /** Number of last assistant turns to always protect (default: 3) */
  keepLastAssistants?: number;
  /** Minimum chars in prunable tools before triggering hard clear (default: 20000) */
  minPrunableChars?: number;
  /** Soft trim settings */
  softTrim?: {
    /** Max chars before a tool result triggers soft trimming (default: 4000) */
    maxChars?: number;
    /** Chars to keep from the beginning (default: 1500) */
    headChars?: number;
    /** Chars to keep from the end (default: 1500) */
    tailChars?: number;
  };
  /** Hard clear placeholder text (default: "[Tool result cleared for context space]") */
  hardClearPlaceholder?: string;
  /** Tool names that should NEVER be pruned */
  protectedTools?: string[];
};

export type EffectiveContextPruningSettings = {
  enabled: boolean;
  softTrimRatio: number;
  hardClearRatio: number;
  keepLastAssistants: number;
  minPrunableChars: number;
  softTrim: {
    maxChars: number;
    headChars: number;
    tailChars: number;
  };
  hardClearPlaceholder: string;
  protectedTools: Set<string>;
};

export const DEFAULT_CONTEXT_PRUNING_SETTINGS: EffectiveContextPruningSettings = {
  enabled: true,
  softTrimRatio: 0.5,
  hardClearRatio: 0.7,
  keepLastAssistants: 3,
  minPrunableChars: 20_000,
  softTrim: {
    maxChars: 4_000,
    headChars: 1_500,
    tailChars: 1_500,
  },
  hardClearPlaceholder: "[Tool result cleared for context space]",
  protectedTools: new Set<string>(),
};

const ALWAYS_PROTECTED_TOOLS = new Set(["read_file", "write_file", "edit_file", "create_file"]);

export function computeEffectiveSettings(
  raw: ContextPruningConfig | undefined,
): EffectiveContextPruningSettings {
  if (!raw) {
    return { ...DEFAULT_CONTEXT_PRUNING_SETTINGS };
  }

  const settings: EffectiveContextPruningSettings = {
    enabled: raw.enabled ?? DEFAULT_CONTEXT_PRUNING_SETTINGS.enabled,
    softTrimRatio: clampRatio(raw.softTrimRatio, DEFAULT_CONTEXT_PRUNING_SETTINGS.softTrimRatio),
    hardClearRatio: clampRatio(raw.hardClearRatio, DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClearRatio),
    keepLastAssistants: Math.max(
      0,
      Math.floor(raw.keepLastAssistants ?? DEFAULT_CONTEXT_PRUNING_SETTINGS.keepLastAssistants),
    ),
    minPrunableChars: Math.max(
      0,
      Math.floor(raw.minPrunableChars ?? DEFAULT_CONTEXT_PRUNING_SETTINGS.minPrunableChars),
    ),
    softTrim: {
      maxChars: Math.max(
        0,
        Math.floor(raw.softTrim?.maxChars ?? DEFAULT_CONTEXT_PRUNING_SETTINGS.softTrim.maxChars),
      ),
      headChars: Math.max(
        0,
        Math.floor(raw.softTrim?.headChars ?? DEFAULT_CONTEXT_PRUNING_SETTINGS.softTrim.headChars),
      ),
      tailChars: Math.max(
        0,
        Math.floor(raw.softTrim?.tailChars ?? DEFAULT_CONTEXT_PRUNING_SETTINGS.softTrim.tailChars),
      ),
    },
    hardClearPlaceholder:
      raw.hardClearPlaceholder?.trim() || DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClearPlaceholder,
    protectedTools: new Set([...ALWAYS_PROTECTED_TOOLS, ...(raw.protectedTools ?? [])]),
  };

  return settings;
}

function clampRatio(value: number | undefined, defaultValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.min(1, Math.max(0, value));
}

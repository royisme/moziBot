/**
 * Context window guardrails for validating model context window sizes.
 *
 * Provides utilities to:
 * - Resolve effective context window from multiple sources
 * - Block models with insufficient context windows (< 16K tokens)
 * - Warn for models with small context windows (< 32K tokens)
 */

/** Hard minimum: models with context window below this are blocked */
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;

/** Warning threshold: models with context window below this are warned */
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

/** Default context window when no other source is available */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/** Source of the context window value */
export type ContextWindowSource = "model" | "config" | "default";

/** Information about the resolved context window */
export type ContextWindowInfo = {
  tokens: number;
  source: ContextWindowSource;
};

/** Result of evaluating guardrails on a context window */
export type ContextWindowGuardResult = ContextWindowInfo & {
  shouldWarn: boolean;
  shouldBlock: boolean;
  message?: string;
};

/**
 * Normalize a value to a positive integer.
 * Returns null for non-finite, non-positive, or non-number values.
 */
function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

/**
 * Resolve the effective context window from multiple sources.
 *
 * Priority:
 * 1. configContextTokens (from agents.defaults.contextTokens) -- acts as cap, takes minimum
 * 2. modelContextWindow (from model registry)
 * 3. defaultTokens (fallback, default 200_000)
 *
 * Non-positive or non-finite values are ignored.
 *
 * @param params - Resolution parameters
 * @returns ContextWindowInfo with tokens and source
 */
export function resolveContextWindowInfo(params: {
  modelContextWindow?: number;
  configContextTokens?: number;
  defaultTokens?: number;
}): ContextWindowInfo {
  const defaultTokens = normalizePositiveInt(params.defaultTokens) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;

  // Get base value from model or default
  const fromModel = normalizePositiveInt(params.modelContextWindow);
  const baseInfo: ContextWindowInfo = fromModel
    ? { tokens: fromModel, source: "model" }
    : { tokens: defaultTokens, source: "default" };

  // Apply cap from config if present and lower
  const capTokens = normalizePositiveInt(params.configContextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return { tokens: capTokens, source: "config" };
  }

  return baseInfo;
}

/**
 * Evaluate guardrails on a resolved context window.
 *
 * - shouldBlock = true when tokens < hardMinTokens (default 16_000)
 * - shouldWarn = true when tokens >= hardMinTokens and < warnBelowTokens (default 32_000)
 *
 * @param params - Evaluation parameters
 * @returns ContextWindowGuardResult with shouldWarn, shouldBlock, and optional message
 */
export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const warnBelow = Math.max(
    1,
    Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS),
  );
  const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS));
  const tokens = Math.max(0, Math.floor(params.info.tokens));

  const shouldBlock = tokens > 0 && tokens < hardMin;
  const shouldWarn = tokens > 0 && tokens >= hardMin && tokens < warnBelow;

  let message: string | undefined;
  if (shouldBlock) {
    message = `Model context window (${tokens}) is below minimum (${hardMin})`;
  } else if (shouldWarn) {
    message = `Model context window (${tokens}) is below recommended (${warnBelow})`;
  }

  return {
    tokens,
    source: params.info.source,
    shouldWarn,
    shouldBlock,
    message,
  };
}

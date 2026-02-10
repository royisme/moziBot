/**
 * Context management module exports.
 *
 * Provides utilities for:
 * - Error detection (context overflow, compaction failures)
 * - Context window guardrails
 * - Auto-compaction
 * - History turn limits
 */

export {
  isContextOverflowError,
  isLikelyContextOverflowError,
  isCompactionFailureError,
} from "./overflow-detection";

export {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
} from "./context-window-guard";

export type {
  ContextWindowSource,
  ContextWindowInfo,
  ContextWindowGuardResult,
} from "./context-window-guard";

export {
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  estimateTokens,
  estimateMessagesTokens,
  splitMessagesByTokenShare,
  chunkMessagesByMaxTokens,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  repairToolUseResultPairing,
  pruneHistoryForContextShare,
  compactMessages,
  createSummaryMessage,
} from "./compaction";

export type { SummaryParams, CompactionResult, CompactMessagesParams } from "./compaction";

export {
  limitHistoryTurns,
  resolveHistoryLimitFromSessionKey,
  isDmSessionKey,
  extractDmPeerId,
} from "./history-limits";

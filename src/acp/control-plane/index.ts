/**
 * ACP Control Plane
 *
 * Core session management, caching, queuing, and runtime controls.
 */

export { AcpSessionManager } from "./manager";
export type {
  AcpCloseSessionInput,
  AcpCloseSessionResult,
  AcpInitializeSessionInput,
  AcpManagerObservabilitySnapshot,
  AcpRunTurnInput,
  AcpSessionManagerDeps,
  AcpSessionResolution,
  AcpSessionStatus,
  AcpStartupIdentityReconcileResult,
  ActiveTurnState,
  TurnLatencyStats,
} from "./manager.types";
export { DEFAULT_DEPS } from "./manager.types";

export {
  normalizeSessionKey,
  normalizeActorKey,
  resolveAcpAgentFromSessionKey,
  resolveMissingMetaError,
  normalizeAcpErrorCode,
  createUnsupportedControlError,
  resolveRuntimeIdleTtlMs,
  hasLegacyAcpIdentityProjection,
} from "./manager.utils";

export { reconcileManagerRuntimeSessionIdentifiers } from "./manager.identity-reconcile";

export {
  resolveManagerRuntimeCapabilities,
  applyManagerRuntimeControls,
} from "./manager.runtime-controls";

export type { CachedRuntimeState, CachedRuntimeSnapshot } from "./runtime-cache";
export { RuntimeCache } from "./runtime-cache";

export { SessionActorQueue } from "./session-actor-queue";

export {
  validateRuntimeModeInput,
  validateRuntimeModelInput,
  validateRuntimePermissionProfileInput,
  validateRuntimeCwdInput,
  validateRuntimeTimeoutSecondsInput,
  parseRuntimeTimeoutSecondsInput,
  validateRuntimeConfigOptionInput,
  validateRuntimeOptionPatch,
  normalizeText,
  normalizeRuntimeOptions,
  mergeRuntimeOptions,
  resolveRuntimeOptionsFromMeta,
  runtimeOptionsEqual,
  buildRuntimeControlSignature,
  buildRuntimeConfigOptionPairs,
  inferRuntimeOptionPatchFromConfigOption,
} from "./runtime-options";

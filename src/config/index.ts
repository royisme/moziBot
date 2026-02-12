export { loadConfig, resolveConfigPath, type ConfigLoadResult } from "./loader";
export { MoziConfigSchema, type MoziConfig } from "./schema";
export { readConfigSnapshot, hashConfigRaw, type ConfigSnapshot } from "./snapshot";
export {
  writeConfigRawAtomic,
  ConfigConflictError,
  type WriteConfigRawOptions,
} from "./persistence";
export {
  setConfigValue,
  deleteConfigValue,
  patchConfig,
  applyConfigOps,
  isConfigConflictError,
  CONFIG_REDACTION_SENTINEL,
  type ConfigOperation,
  type MutateConfigOptions,
  type MutationResult,
} from "./lifecycle";

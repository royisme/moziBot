export {
  ProcessRegistry,
  getProcessRegistry,
  setProcessRegistry,
  closeProcessRegistry,
} from "./process-registry.js";
export type { ProcessRecord, ProcessSessionRecord, ProcessStatus } from "./process-registry.js";

export {
  getProcessSupervisor,
  setProcessSupervisor,
  resetProcessSupervisor,
  createProcessSupervisor,
} from "./supervisor/index.js";
export type {
  ProcessSupervisor,
  ManagedRun,
  RunExit,
  RunRecord,
  RunState,
  SpawnInput,
  SpawnMode,
  TerminationReason,
} from "./supervisor/index.js";

export { createProcessTool } from "./process-tool.js";
export type { ProcessOperation } from "./process-tool.js";

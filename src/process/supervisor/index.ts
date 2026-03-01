import { createProcessSupervisor } from "./supervisor.js";
import type { ProcessSupervisor } from "./types.js";

let singleton: ProcessSupervisor | null = null;

export function getProcessSupervisor(): ProcessSupervisor {
  if (singleton) {
    return singleton;
  }
  singleton = createProcessSupervisor();
  return singleton;
}

export function setProcessSupervisor(supervisor: ProcessSupervisor): void {
  singleton = supervisor;
}

export function resetProcessSupervisor(): void {
  singleton = null;
}

export { createProcessSupervisor } from "./supervisor.js";
export type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  RunRecord,
  RunState,
  SpawnInput,
  SpawnMode,
  TerminationReason,
} from "./types.js";

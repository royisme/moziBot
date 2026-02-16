import type { OrchestratorDeps } from "../contract";
import {
  composeOrchestratorDeps,
  type OrchestratorDepsBuilderParams,
} from "./orchestrator-deps-slices";

export function buildOrchestratorDeps(params: OrchestratorDepsBuilderParams): OrchestratorDeps {
  return composeOrchestratorDeps(params);
}

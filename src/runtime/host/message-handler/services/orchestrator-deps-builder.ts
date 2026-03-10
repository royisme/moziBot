import type { OrchestratorDeps } from "../contract";
import {
  composeOrchestratorDeps,
  type OrchestratorDepsBuilderParams,
} from "./orchestrator-deps-slices";

export function buildOrchestratorDeps(params: OrchestratorDepsBuilderParams): OrchestratorDeps {
  return {
    ...composeOrchestratorDeps(params),
    registerSessionContext: (sessionKey, ctx) =>
      params.agentManager.registerSessionContext?.(sessionKey, ctx),
    clearSessionContext: (sessionKey) => params.agentManager.clearSessionContext?.(sessionKey),
  };
}

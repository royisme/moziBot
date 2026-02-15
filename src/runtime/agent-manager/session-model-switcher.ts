import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { MoziConfig } from "../../config";
import type { ModelRegistry } from "../model-registry";
import type { SessionStore } from "../session-store";
import type { ModelSpec } from "../types";
import { shouldSanitizeTools } from "./tool-builder";

export async function setSessionModelWithSwitch(params: {
  sessionKey: string;
  modelRef: string;
  options?: { persist?: boolean };
  sessions: SessionStore;
  runtimeModelOverrides: Map<string, string>;
  agents: Map<string, AgentSession>;
  agentModelRefs: Map<string, string>;
  modelRegistry: ModelRegistry;
  config: MoziConfig;
  buildPiModel: (spec: ModelSpec) => Model<Api>;
}): Promise<void> {
  const persist = params.options?.persist ?? true;
  if (persist) {
    params.sessions.update(params.sessionKey, { currentModel: params.modelRef });
    params.runtimeModelOverrides.delete(params.sessionKey);
  } else {
    params.runtimeModelOverrides.set(params.sessionKey, params.modelRef);
  }

  const agent = params.agents.get(params.sessionKey);
  if (!agent) {
    return;
  }

  const spec = params.modelRegistry.get(params.modelRef);
  if (!spec) {
    return;
  }

  const oldModelRef = params.agentModelRefs.get(params.sessionKey);
  if (oldModelRef) {
    const oldSpec = params.modelRegistry.get(oldModelRef);
    const oldNeedsSanitize = oldSpec ? shouldSanitizeTools(params.config, oldSpec) : false;
    const newNeedsSanitize = shouldSanitizeTools(params.config, spec);
    if (oldNeedsSanitize !== newNeedsSanitize) {
      agent.dispose();
      params.agents.delete(params.sessionKey);
      params.agentModelRefs.delete(params.sessionKey);
      return;
    }
  }

  await agent.setModel(params.buildPiModel(spec));
  params.agentModelRefs.set(params.sessionKey, params.modelRef);
}

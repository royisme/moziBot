import type { MoziConfig } from "../../config";
import type { ModelRegistry } from "../model-registry";
import type { SessionStore } from "../session-store";
import type { AgentEntry } from "./config-resolver";
import { resolveAgentModelRouting } from "../../config/model-routing";

type ModalityInput = "text" | "image" | "audio" | "video" | "file";
type NonTextModalityInput = "image" | "audio" | "video" | "file";

export function resolveAgentModelRef(params: {
  config: MoziConfig;
  agentId: string;
  entry?: AgentEntry;
}): string | undefined {
  const routing = resolveAgentModelRouting(params.config, params.agentId);
  if (routing.defaultModel.primary) {
    return routing.defaultModel.primary;
  }
  if (params.entry?.model && typeof params.entry.model === "string") {
    return params.entry.model;
  }
  return undefined;
}

export function getAgentFallbacks(params: { config: MoziConfig; agentId: string }): string[] {
  const routing = resolveAgentModelRouting(params.config, params.agentId);
  return routing.defaultModel.fallbacks;
}

export function resolveLifecycleControlModel(params: {
  sessionKey: string;
  agentId?: string;
  config: MoziConfig;
  sessions: SessionStore;
  modelRegistry: ModelRegistry;
  resolveDefaultAgentId: () => string;
  getAgentEntry: (agentId: string) => AgentEntry | undefined;
}): {
  modelRef: string;
  source: "session" | "agent" | "defaults" | "fallback";
} {
  const { sessionKey } = params;
  const resolvedAgentId = params.agentId || params.resolveDefaultAgentId();
  const entry = params.getAgentEntry(resolvedAgentId);
  const defaults = (params.config.agents?.defaults as AgentEntry | undefined) || undefined;
  const sessionControl =
    (params.sessions.get(sessionKey)?.metadata?.lifecycle as { controlModel?: string } | undefined)
      ?.controlModel || undefined;

  if (sessionControl && params.modelRegistry.get(sessionControl)) {
    return { modelRef: sessionControl, source: "session" };
  }

  const agentControl = entry?.lifecycle?.control?.model;
  if (agentControl && params.modelRegistry.get(agentControl)) {
    return { modelRef: agentControl, source: "agent" };
  }

  const defaultsControl = defaults?.lifecycle?.control?.model;
  if (defaultsControl && params.modelRegistry.get(defaultsControl)) {
    return { modelRef: defaultsControl, source: "defaults" };
  }

  const fallbacks = [
    ...(entry?.lifecycle?.control?.fallback || []),
    ...(defaults?.lifecycle?.control?.fallback || []),
  ];
  const deterministic = Array.from(new Set(fallbacks)).toSorted();
  for (const ref of deterministic) {
    if (params.modelRegistry.get(ref)) {
      return { modelRef: ref, source: "fallback" };
    }
  }

  const defaultReply = resolveAgentModelRef({
    config: params.config,
    agentId: resolvedAgentId,
    entry,
  });
  if (defaultReply && params.modelRegistry.get(defaultReply)) {
    return { modelRef: defaultReply, source: "fallback" };
  }

  const first = params.modelRegistry
    .list()
    .map((spec) => `${spec.provider}/${spec.id}`)
    .toSorted()[0];
  if (!first) {
    throw new Error("No model available for lifecycle control plane");
  }
  return { modelRef: first, source: "fallback" };
}

export function modelSupportsInput(params: {
  modelRegistry: ModelRegistry;
  modelRef: string;
  input: ModalityInput;
}): boolean {
  const spec = params.modelRegistry.get(params.modelRef);
  if (!spec) {
    return false;
  }
  const supported = spec.input ?? ["text"];
  return supported.includes(params.input);
}

function getAgentModalityModelRef(params: {
  config: MoziConfig;
  agentId: string;
  modality: NonTextModalityInput;
}): string | undefined {
  const routing = resolveAgentModelRouting(params.config, params.agentId);
  if (params.modality !== "image") {
    return undefined;
  }
  return routing.imageModel.primary;
}

function getAgentModalityFallbacks(params: {
  config: MoziConfig;
  agentId: string;
  modality: NonTextModalityInput;
}): string[] {
  const routing = resolveAgentModelRouting(params.config, params.agentId);
  if (params.modality !== "image") {
    return [];
  }
  return routing.imageModel.fallbacks;
}

export function resolveModalityRoutingCandidates(params: {
  config: MoziConfig;
  agentId: string;
  modality: NonTextModalityInput;
}): string[] {
  const refs = [
    getAgentModalityModelRef(params),
    ...getAgentModalityFallbacks(params),
    ...getAgentFallbacks({ config: params.config, agentId: params.agentId }),
  ].filter((ref): ref is string => Boolean(ref));
  return Array.from(new Set(refs));
}

export function listCapableModels(params: {
  modelRegistry: ModelRegistry;
  input: ModalityInput;
}): string[] {
  return params.modelRegistry
    .list()
    .filter((spec) => (spec.input ?? ["text"]).includes(params.input))
    .map((spec) => `${spec.provider}/${spec.id}`)
    .toSorted();
}

export async function ensureSessionModelForInput(params: {
  sessionKey: string;
  agentId: string;
  input: ModalityInput;
  config: MoziConfig;
  modelRegistry: ModelRegistry;
  getAgent: (sessionKey: string, agentId: string) => Promise<{ modelRef: string }>;
  setSessionModel: (
    sessionKey: string,
    modelRef: string,
    options?: { persist?: boolean },
  ) => Promise<void>;
}): Promise<
  | { ok: true; modelRef: string; switched: boolean }
  | { ok: false; modelRef: string; candidates: string[] }
> {
  const { sessionKey, agentId, input } = params;
  const { modelRef } = await params.getAgent(sessionKey, agentId);
  if (modelSupportsInput({ modelRegistry: params.modelRegistry, modelRef, input })) {
    return { ok: true, modelRef, switched: false };
  }

  if (input === "text") {
    return {
      ok: false,
      modelRef,
      candidates: listCapableModels({ modelRegistry: params.modelRegistry, input: "text" }),
    };
  }

  const candidates = resolveModalityRoutingCandidates({
    config: params.config,
    agentId,
    modality: input,
  });
  for (const candidate of candidates) {
    const resolved = params.modelRegistry.resolve(candidate);
    if (!resolved) {
      continue;
    }
    if (
      !modelSupportsInput({ modelRegistry: params.modelRegistry, modelRef: resolved.ref, input })
    ) {
      continue;
    }
    await params.setSessionModel(sessionKey, resolved.ref, { persist: false });
    return { ok: true, modelRef: resolved.ref, switched: resolved.ref !== modelRef };
  }

  return {
    ok: false,
    modelRef,
    candidates: listCapableModels({ modelRegistry: params.modelRegistry, input }),
  };
}

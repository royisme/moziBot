import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { MoziConfig } from "../../config";
import type { ModelRegistry } from "../model-registry";
import type { SessionStore } from "../session-store";
import type { ModelSpec } from "../types";
import type { AgentEntry } from "./config-resolver";
import {
  ensureSessionModelForInput as ensureSessionModelForInputRouting,
  getAgentFallbacks as getAgentFallbacksRouting,
  resolveAgentModelRef as resolveAgentModelRefRouting,
  resolveLifecycleControlModel as resolveLifecycleControlModelRouting,
} from "./model-routing-service";
import { setSessionModelWithSwitch } from "./session-model-switcher";

export function resolveAgentModelRef(params: {
  config: MoziConfig;
  agentId: string;
  entry?: AgentEntry;
}): string | undefined {
  return resolveAgentModelRefRouting(params);
}

export function getAgentFallbacks(params: { config: MoziConfig; agentId: string }): string[] {
  return getAgentFallbacksRouting(params);
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
  return resolveLifecycleControlModelRouting(params);
}

export async function ensureSessionModelForInput(params: {
  sessionKey: string;
  agentId: string;
  input: "text" | "image" | "audio" | "video" | "file";
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
  return await ensureSessionModelForInputRouting(params);
}

export async function setSessionModel(params: {
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
  await setSessionModelWithSwitch(params);
}

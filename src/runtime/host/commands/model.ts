import type { ChannelPlugin } from "../../adapters/channels/plugin";
import type { AgentManager } from "../../agent-manager";
import type { ModelRegistry } from "../../model-registry";

export async function handleModelsCommand(params: {
  sessionKey: string;
  agentId: string;
  channel: ChannelPlugin;
  peerId: string;
  agentManager: AgentManager;
  modelRegistry: ModelRegistry;
}): Promise<void> {
  const { sessionKey, agentId, channel, peerId, agentManager, modelRegistry } = params;
  const current = await agentManager.getAgent(sessionKey, agentId);
  const refs = modelRegistry
    .list()
    .map((spec) => `${spec.provider}/${spec.id}`)
    .toSorted();
  if (refs.length === 0) {
    await channel.send(peerId, {
      text: "No models available. Please add models.providers to the configuration.",
    });
    return;
  }
  const lines = ["Available models:"];
  for (const ref of refs) {
    if (ref === current.modelRef) {
      lines.push(`- ${ref} (current)`);
    } else {
      lines.push(`- ${ref}`);
    }
  }
  lines.push("Switch model: /switch provider/model");
  await channel.send(peerId, { text: lines.join("\n") });
}

export async function handleSwitchCommand(params: {
  sessionKey: string;
  agentId: string;
  args: string;
  channel: ChannelPlugin;
  peerId: string;
  agentManager: AgentManager;
  modelRegistry: ModelRegistry;
}): Promise<void> {
  const { sessionKey, agentId, args, channel, peerId, agentManager, modelRegistry } = params;
  const modelRef = args.trim();
  if (!modelRef) {
    const current = await agentManager.getAgent(sessionKey, agentId);
    await channel.send(peerId, {
      text: `Current model: ${current.modelRef}\nUsage: /switch provider/model`,
    });
    return;
  }
  const resolved = modelRegistry.resolve(modelRef);
  if (!resolved) {
    const suggestions = modelRegistry.suggestRefs(modelRef, 5);
    const suggestText =
      suggestions.length > 0
        ? `\nExample available models:\n${suggestions.map((ref) => `- ${ref}`).join("\n")}`
        : "";
    await channel.send(peerId, { text: `Model not found: ${modelRef}${suggestText}` });
    return;
  }
  await agentManager.setSessionModel(sessionKey, resolved.ref);
  if (resolved.ref !== modelRef) {
    await channel.send(peerId, {
      text: `Switched to model: ${resolved.ref} (auto-corrected from: ${modelRef})`,
    });
    return;
  }
  await channel.send(peerId, { text: `Switched to model: ${resolved.ref}` });
}

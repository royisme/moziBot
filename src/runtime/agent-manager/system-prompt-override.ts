import type { AgentSession } from "@mariozechner/pi-coding-agent";

export function applySystemPromptOverrideToSession(
  session: AgentSession,
  systemPrompt: string,
): void {
  const prompt = systemPrompt.trim();
  session.agent.setSystemPrompt(prompt);

  const mutableSession = session as unknown as {
    _baseSystemPrompt?: string;
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
  };
  mutableSession._baseSystemPrompt = prompt;
  mutableSession._rebuildSystemPrompt = () => prompt;
}

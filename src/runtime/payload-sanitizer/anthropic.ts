import type { AgentMessage } from "@mariozechner/pi-agent-core";

export function validateAnthropicTurns(messages: AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const result: AgentMessage[] = [];
  let lastRole: string | undefined;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role;
    if (typeof msgRole !== "string") {
      result.push(msg);
      continue;
    }

    if (msgRole === lastRole && lastRole === "user") {
      const lastMsg = result[result.length - 1];
      if (!lastMsg || typeof lastMsg !== "object") {
        result.push(msg);
        lastRole = msgRole;
        continue;
      }
      const previous = lastMsg as Extract<AgentMessage, { role: "user" }>;
      const current = msg as Extract<AgentMessage, { role: "user" }>;
      const merged: Extract<AgentMessage, { role: "user" }> = {
        ...current,
        content: [
          ...(Array.isArray(previous.content) ? previous.content : []),
          ...(Array.isArray(current.content) ? current.content : []),
        ],
        timestamp: current.timestamp ?? previous.timestamp,
      };
      result[result.length - 1] = merged;
      continue;
    }

    result.push(msg);
    lastRole = msgRole;
  }

  return result;
}

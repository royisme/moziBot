import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ResolvedMemoryPersistenceConfig } from "./backend-config";

export interface FlushMetadata {
  lastAttemptedCycle: number;
  lastTimestamp: number;
  lastStatus: "success" | "failure";
}

export interface FlushResult {
  ready: boolean;
  summary: string | null;
}

export class FlushManager {
  async flush(params: {
    messages: AgentMessage[];
    config: ResolvedMemoryPersistenceConfig;
  }): Promise<FlushResult> {
    const { messages, config } = params;
    if (!config.enabled) {
      return { ready: false, summary: null };
    }

    const summary = this.buildMarkdownEntry(messages, config);
    return {
      ready: summary !== null,
      summary,
    };
  }

  private renderContent(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
            return part.text;
          }
          return JSON.stringify(part);
        })
        .join("");
    }
    return JSON.stringify(content);
  }

  private buildMarkdownEntry(
    messages: AgentMessage[],
    config: ResolvedMemoryPersistenceConfig,
  ): string | null {
    const relevant = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-config.maxMessages);

    if (relevant.length === 0) {
      return null;
    }

    let content = `\n\n### Session Flush ${new Date().toISOString()}\n\n`;
    for (const msg of relevant) {
      const rolePrefix = msg.role === "user" ? "**User:**" : "**Assistant:**";
      const text = this.renderContent(msg.content);
      content += `${rolePrefix} ${text}\n\n`;
    }

    if (content.length > config.maxChars) {
      content = content.slice(0, config.maxChars) + "\n... (truncated)\n";
    }

    return content;
  }
}

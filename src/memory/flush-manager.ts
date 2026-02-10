import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedMemoryPersistenceConfig } from "./backend-config";
import { logger } from "../logger";

export interface FlushMetadata {
  lastAttemptedCycle: number;
  lastTimestamp: number;
  lastStatus: "success" | "failure";
}

export class FlushManager {
  constructor(private homeDir: string) {}

  async flush(params: {
    messages: AgentMessage[];
    config: ResolvedMemoryPersistenceConfig;
    sessionKey: string;
  }): Promise<boolean> {
    const { messages, config } = params;
    if (!config.enabled) {
      return false;
    }

    try {
      const memoryDir = path.join(this.homeDir, "memory");
      await fs.mkdir(memoryDir, { recursive: true });

      const date = new Date().toISOString().split("T")[0];
      const targetFile = path.join(memoryDir, `${date}.md`);

      const entry = this.buildMarkdownEntry(messages, config);
      if (!entry) {
        return false;
      }

      await fs.appendFile(targetFile, entry, "utf-8");
      return true;
    } catch (err) {
      logger.warn({ err, sessionKey: params.sessionKey }, "Memory flush failed (best-effort)");
      return false;
    }
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

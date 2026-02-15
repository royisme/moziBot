import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { MoziConfig } from "../../config";
import type { SessionStore } from "../session-store";

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

export function resolveThinkingLevel(params: {
  config: MoziConfig;
  sessions: SessionStore;
  entry?: { thinking?: ThinkingLevel; metadata?: { thinkingLevel?: ThinkingLevel | null } };
  sessionKey?: string;
}): ThinkingLevel | undefined {
  const sessionLevel = params.sessionKey
    ? (params.sessions.get(params.sessionKey)?.metadata as { thinkingLevel?: unknown } | undefined)
        ?.thinkingLevel
    : undefined;
  if (isThinkingLevel(sessionLevel)) {
    return sessionLevel;
  }
  const defaults =
    (params.config.agents?.defaults as { thinking?: ThinkingLevel } | undefined)?.thinking ||
    undefined;
  return params.entry?.thinking ?? defaults;
}

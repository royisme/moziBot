export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ReasoningLevel = "off" | "on" | "stream";

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return value === "off" || value === "on" || value === "stream";
}

/**
 * Semantic Lifecycle Pure Functions
 * 
 * This module contains pure logic for intent-based session rotation.
 * It uses NLP techniques to estimate topic shifts between user messages.
 */

export interface SemanticLifecyclePolicy {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly debounceSeconds: number;
  readonly reversible: boolean;
}

export interface SemanticSessionMetadata {
  readonly lastRotationAt?: number;
  readonly lastTrigger?: string;
  readonly lastConfidence?: number;
  readonly lastRotationType?: string;
}

export interface SemanticLifecycleResult {
  readonly shouldRotate: boolean;
  readonly shouldRevert: boolean;
  readonly confidence: number;
  readonly threshold: number;
}

/**
 * Resolves the semantic lifecycle policy for a specific agent.
 */
export function resolveSemanticLifecyclePolicy(
  agentId: string,
  configAgents: Record<string, unknown> | undefined
): SemanticLifecyclePolicy {
  const agents = configAgents || {};
  const defaults = (agents.defaults as { lifecycle?: { semantic?: Partial<SemanticLifecyclePolicy> } } | undefined)
    ?.lifecycle?.semantic;
  const entry = (agents[agentId] as { lifecycle?: { semantic?: Partial<SemanticLifecyclePolicy> } } | undefined)
    ?.lifecycle?.semantic;

  return {
    enabled: entry?.enabled ?? defaults?.enabled ?? false,
    threshold: entry?.threshold ?? defaults?.threshold ?? 0.8,
    debounceSeconds: entry?.debounceSeconds ?? defaults?.debounceSeconds ?? 60,
    reversible: entry?.reversible ?? defaults?.reversible ?? true,
  };
}

/**
 * Extracts raw text content from a message payload.
 */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const maybe = part as { type?: string; text?: string; content?: string };
        if (typeof maybe?.text === "string") {
          return maybe.text;
        }
        if (maybe?.type === "text" && typeof maybe?.content === "string") {
          return maybe.content;
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

/**
 * Extracts the text of the last message sent by a user from the context history.
 */
export function extractLastUserTextFromContext(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role !== "user") {
      continue;
    }
    const text = extractTextFromContent(msg.content);
    if (text.trim().length > 0) {
      return text;
    }
  }
  return "";
}

/**
 * Tokenizes text into a set of meaningful topic keywords.
 */
export function tokenizeTopic(text: string): Set<string> {
  const stopWords = new Set(["the", "and", "for", "with", "that", "this", "you", "are"]);
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .filter((w) => !stopWords.has(w));
  return new Set(words);
}

/**
 * Estimates the confidence level of a semantic shift between two texts.
 * Uses Jaccard similarity and explicit pattern matching.
 */
export function estimateSemanticShiftConfidence(prevText: string, nextText: string): number {
  if (!prevText.trim()) {
    return 0;
  }
  const prev = tokenizeTopic(prevText);
  const next = tokenizeTopic(nextText);
  if (prev.size === 0 || next.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of prev) {
    if (next.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...prev, ...next]).size;
  const similarity = union > 0 ? intersection / union : 0;
  let confidence = 1 - similarity;

  const explicitShiftPattern = /^(new\s+topic|switch\s+topic|换个话题|另外一个问题|design\b|marketing\b|slogan\b)\b/i;
  if (explicitShiftPattern.test(nextText.trim())) {
    confidence = Math.min(1, confidence + 0.2);
  }
  return Number(confidence.toFixed(4));
}

/**
 * Evaluates the semantic lifecycle to determine if a session should rotate or revert.
 */
export function evaluateSemanticLifecycle(params: {
  policy: SemanticLifecyclePolicy;
  currentText: string;
  previousMessages: unknown[];
  metadata: SemanticSessionMetadata;
  nowMs?: number;
}): SemanticLifecycleResult {
  const { policy, currentText, previousMessages, metadata, nowMs = Date.now() } = params;

  if (!policy.enabled) {
    return {
      shouldRotate: false,
      shouldRevert: false,
      confidence: 0,
      threshold: policy.threshold,
    };
  }

  const previousUserText = extractLastUserTextFromContext(previousMessages);
  const confidence = estimateSemanticShiftConfidence(previousUserText, currentText);

  const lastRotationAt = metadata.lastRotationAt ?? 0;
  if (policy.debounceSeconds > 0 && nowMs - lastRotationAt < policy.debounceSeconds * 1000) {
    const canRevert =
      policy.reversible &&
      metadata.lastRotationType === "semantic" &&
      confidence < Math.max(0.15, policy.threshold * 0.5);
    
    return {
      shouldRotate: false,
      shouldRevert: canRevert,
      confidence,
      threshold: policy.threshold,
    };
  }

  return {
    shouldRotate: confidence >= policy.threshold,
    shouldRevert: false,
    confidence,
    threshold: policy.threshold,
  };
}

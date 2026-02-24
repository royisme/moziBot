import type { StatusReaction } from "./types";

export type StatusReactionEmojis = Partial<Record<StatusReaction, string>>;

export const DEFAULT_STATUS_REACTION_EMOJIS: Record<StatusReaction, string> = {
  queued: "👀",
  thinking: "🤔",
  tool: "🔥",
  done: "👍",
  error: "😱",
};

function normalizeEmoji(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveStatusReactionEmoji(
  status: StatusReaction,
  overrides?: StatusReactionEmojis,
): string {
  return normalizeEmoji(overrides?.[status]) ?? DEFAULT_STATUS_REACTION_EMOJIS[status];
}

export function resolveStatusReactionEmojis(
  overrides?: StatusReactionEmojis,
): Record<StatusReaction, string> {
  return {
    queued: resolveStatusReactionEmoji("queued", overrides),
    thinking: resolveStatusReactionEmoji("thinking", overrides),
    tool: resolveStatusReactionEmoji("tool", overrides),
    done: resolveStatusReactionEmoji("done", overrides),
    error: resolveStatusReactionEmoji("error", overrides),
  };
}

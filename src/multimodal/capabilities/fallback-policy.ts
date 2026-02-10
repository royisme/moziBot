import type { ContentPart, Modality, TextPart } from "../protocol/index.ts";
import type { TransformStep } from "./profile.ts";

export interface FallbackDecision {
  accepted: boolean;
  providerPart?: ContentPart;
  transform?: TransformStep;
  reason?: string;
}

export function applyFallbackToText(part: ContentPart): FallbackDecision {
  if (part.modality === "text") {
    return { accepted: true, providerPart: part };
  }

  const mapping: Record<Exclude<Modality, "text">, string> = {
    image: "[image omitted: no compatible image pipeline available]",
    audio: "[audio omitted: no compatible audio pipeline available]",
    video: "[video omitted: no compatible video pipeline available]",
    file: "[file omitted: no compatible file pipeline available]",
  };

  const textPart: TextPart = {
    id: `${part.id}:fallback:text`,
    role: part.role,
    index: part.index,
    modality: "text",
    text: mapping[part.modality],
    format: "plain",
  };

  return {
    accepted: true,
    providerPart: textPart,
    transform: {
      type: "summarize",
      from: part.modality,
      to: "text",
      reason: `Fallback conversion from ${part.modality} to text`,
    },
  };
}

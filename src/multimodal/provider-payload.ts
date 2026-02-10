import type { DeliveryPlan } from "./capabilities";

export type ProviderInputPayload = {
  text: string;
  media: Array<{
    modality: "image" | "audio" | "video" | "file";
    mediaId: string;
    mimeType?: string;
    filename?: string;
  }>;
  metadata: {
    fallbackUsed: boolean;
    transforms: Array<{ type: string; from: string; to: string; reason: string }>;
  };
};

export function buildProviderInputPayload(
  plan: DeliveryPlan | null | undefined,
): ProviderInputPayload {
  const providerInput = plan?.providerInput ?? [];
  const textLines: string[] = [];
  const media: ProviderInputPayload["media"] = [];

  for (const part of providerInput) {
    if (part.modality === "text") {
      const value = part.text.trim();
      if (value) {
        textLines.push(value);
      }
      continue;
    }
    media.push({
      modality: part.modality,
      mediaId: part.media.mediaId,
      mimeType: part.media.mimeType,
      filename: part.media.filename,
    });
  }

  return {
    text: textLines.join("\n\n").trim(),
    media,
    metadata: {
      fallbackUsed: Boolean(plan?.fallbackUsed),
      transforms: (plan?.transforms ?? []).map((t) => ({
        type: t.type,
        from: t.from,
        to: t.to,
        reason: t.reason,
      })),
    },
  };
}

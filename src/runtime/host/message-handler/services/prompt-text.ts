import type { DeliveryPlan } from "../../../../multimodal/capabilities";
import type { InboundMessage } from "../../../adapters/channels/types";
import { buildProviderInputPayload } from "../../../../multimodal/provider-payload";

export function buildRawTextWithTranscription(rawText: string, transcript: string | null): string {
  if (!transcript) {
    return rawText;
  }

  const base = rawText.trim();
  if (!base) {
    return transcript;
  }
  return `${base}\n\n[voice transcript]\n${transcript}`;
}

export function buildPromptText(params: {
  message: InboundMessage;
  rawText: string;
  ingestPlan?: DeliveryPlan | null;
}): string {
  const lines: string[] = [];
  const providerPayload = buildProviderInputPayload(params.ingestPlan);
  const trimmed = params.rawText.trim();
  if (trimmed) {
    lines.push(trimmed);
  }

  if (providerPayload.text && !lines.includes(providerPayload.text)) {
    lines.push(providerPayload.text);
  }

  if (providerPayload.media.length > 0) {
    const mediaSummary = providerPayload.media
      .map((item, index) => {
        const mime = item.mimeType ? `, mime=${item.mimeType}` : "";
        const filename = item.filename ? `, filename=${item.filename}` : "";
        return `- [media#${index + 1}] modality=${item.modality}, id=${item.mediaId}${mime}${filename}`;
      })
      .join("\n");
    lines.push(`Attached media:\n${mediaSummary}`);
  }

  if (providerPayload.metadata.fallbackUsed && providerPayload.metadata.transforms.length > 0) {
    const transformSummary = providerPayload.metadata.transforms
      .map((item) => `- ${item.from} -> ${item.to} (${item.reason})`)
      .join("\n");
    lines.push(`Input degradation strategy:\n${transformSummary}`);
  }

  return lines.join("\n\n").trim();
}

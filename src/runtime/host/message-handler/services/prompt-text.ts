import type { DeliveryPlan } from "../../../../multimodal/capabilities";
import { buildProviderInputPayload } from "../../../../multimodal/provider-payload";
import type { InboundMessage } from "../../../adapters/channels/types";

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
    lines.push(
      `Attached media metadata (${providerPayload.media.length} item(s)) included for fallback/debug only. Vision-capable providers should consume structured media payloads instead of this summary.`,
    );
  }

  if (providerPayload.metadata.fallbackUsed && providerPayload.metadata.transforms.length > 0) {
    const transformSummary = providerPayload.metadata.transforms
      .map((item) => `- ${item.from} -> ${item.to} (${item.reason})`)
      .join("\n");
    lines.push(`Input degradation strategy:\n${transformSummary}`);
  }

  return lines.join("\n\n").trim();
}

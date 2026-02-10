import type { ContentPart, MediaRef, Modality } from "../protocol/index.ts";
import type {
  CapabilityProfile,
  DeliveryPlan,
  ModalityLimits,
  NegotiationInput,
  TransformStep,
} from "./profile.ts";
import { applyFallbackToText } from "./fallback-policy.ts";

function intersectModalityLimits(
  a: ModalityLimits,
  b: ModalityLimits,
  c: ModalityLimits,
): ModalityLimits {
  const acceptedMimeTypes = intersectMimeLists(
    a.acceptedMimeTypes,
    b.acceptedMimeTypes,
    c.acceptedMimeTypes,
  );
  return {
    enabled: a.enabled && b.enabled && c.enabled,
    maxBytes: minDefined(a.maxBytes, b.maxBytes, c.maxBytes),
    maxDurationMs: minDefined(a.maxDurationMs, b.maxDurationMs, c.maxDurationMs),
    acceptedMimeTypes,
  };
}

function intersectMimeLists(a?: string[], b?: string[], c?: string[]): string[] | undefined {
  const lists = [a, b, c].filter((v): v is string[] => Array.isArray(v));
  if (lists.length === 0) {
    return undefined;
  }
  let current = new Set(lists[0]);
  for (const list of lists.slice(1)) {
    const next = new Set(list);
    current = new Set(Array.from(current).filter((item) => next.has(item)));
  }
  return Array.from(current.values());
}

function minDefined(...values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((v): v is number => typeof v === "number");
  if (filtered.length === 0) {
    return undefined;
  }
  return Math.min(...filtered);
}

function getEffectiveInputLimits(params: {
  modality: Modality;
  channel: CapabilityProfile;
  provider: CapabilityProfile;
  policy: CapabilityProfile;
}): ModalityLimits {
  return intersectModalityLimits(
    params.channel.input[params.modality],
    params.provider.input[params.modality],
    params.policy.input[params.modality],
  );
}

function getEffectiveOutputLimits(params: {
  modality: Modality;
  channel: CapabilityProfile;
  provider: CapabilityProfile;
  policy: CapabilityProfile;
}): ModalityLimits {
  return intersectModalityLimits(
    params.channel.output[params.modality],
    params.provider.output[params.modality],
    params.policy.output[params.modality],
  );
}

function partMedia(part: ContentPart): MediaRef | undefined {
  if (part.modality === "text") {
    return undefined;
  }
  return part.media;
}

function partWithinLimits(part: ContentPart, limits: ModalityLimits): boolean {
  if (!limits.enabled) {
    return false;
  }
  const media = partMedia(part);
  if (!media) {
    return true;
  }
  if (typeof limits.maxBytes === "number" && media.byteSize > limits.maxBytes) {
    return false;
  }
  if (
    typeof limits.maxDurationMs === "number" &&
    typeof media.durationMs === "number" &&
    media.durationMs > limits.maxDurationMs
  ) {
    return false;
  }
  if (
    limits.acceptedMimeTypes &&
    limits.acceptedMimeTypes.length > 0 &&
    !limits.acceptedMimeTypes.includes(media.mimeType)
  ) {
    return false;
  }
  return true;
}

function estimatePartBytes(part: ContentPart): number {
  if (part.modality === "text") {
    return Buffer.byteLength(part.text, "utf8");
  }
  return part.media.byteSize;
}

function selectOutputModalities(params: {
  requested: Modality[];
  channel: CapabilityProfile;
  provider: CapabilityProfile;
  policy: CapabilityProfile;
}): { selected: Modality[]; rejected: Modality[] } {
  const selected: Modality[] = [];
  const rejected: Modality[] = [];
  for (const modality of params.requested) {
    const limits = getEffectiveOutputLimits({
      modality,
      channel: params.channel,
      provider: params.provider,
      policy: params.policy,
    });
    if (limits.enabled) {
      selected.push(modality);
    } else {
      rejected.push(modality);
    }
  }
  return { selected, rejected };
}

export function negotiateDeliveryPlan(input: NegotiationInput): DeliveryPlan {
  const acceptedInput: ContentPart[] = [];
  const providerInput: ContentPart[] = [];
  const transforms: TransformStep[] = [];
  let fallbackUsed = false;

  for (const part of input.requestedInput) {
    const limits = getEffectiveInputLimits({
      modality: part.modality,
      channel: input.channelProfile,
      provider: input.providerProfile,
      policy: input.policyProfile,
    });

    const canPassAsIs = partWithinLimits(part, limits);
    if (canPassAsIs) {
      acceptedInput.push(part);
      providerInput.push(part);
      continue;
    }

    const fallback = applyFallbackToText(part);
    if (!fallback.accepted || !fallback.providerPart) {
      return {
        acceptedInput,
        providerInput,
        outputModalities: [],
        transforms,
        fallbackUsed,
        rejectionReason: fallback.reason || `No viable fallback for modality ${part.modality}`,
      };
    }

    const fallbackLimits = getEffectiveInputLimits({
      modality: fallback.providerPart.modality,
      channel: input.channelProfile,
      provider: input.providerProfile,
      policy: input.policyProfile,
    });
    if (!partWithinLimits(fallback.providerPart, fallbackLimits)) {
      return {
        acceptedInput,
        providerInput,
        outputModalities: [],
        transforms,
        fallbackUsed,
        rejectionReason: `Fallback part exceeded limits for modality ${fallback.providerPart.modality}`,
      };
    }

    fallbackUsed = true;
    acceptedInput.push(part);
    providerInput.push(fallback.providerPart);
    if (fallback.transform) {
      transforms.push(fallback.transform);
    }
  }

  const totalBytes = providerInput.reduce((sum, part) => sum + estimatePartBytes(part), 0);
  if (totalBytes > input.runtime.maxTotalBytes) {
    return {
      acceptedInput,
      providerInput,
      outputModalities: [],
      transforms,
      fallbackUsed,
      rejectionReason: `Provider input exceeds maxTotalBytes (${totalBytes} > ${input.runtime.maxTotalBytes})`,
    };
  }

  const outputSelection = selectOutputModalities({
    requested: input.requestedOutputModalities,
    channel: input.channelProfile,
    provider: input.providerProfile,
    policy: input.policyProfile,
  });

  if (outputSelection.selected.length === 0 && input.requestedOutputModalities.length > 0) {
    fallbackUsed = true;
    const firstRequested = input.requestedOutputModalities[0] ?? "text";
    if (!outputSelection.rejected.includes("text")) {
      outputSelection.selected.push("text");
      transforms.push({
        type: "summarize",
        from: firstRequested,
        to: "text",
        reason: "Output fallback to text due to channel/provider/policy constraints",
      });
    } else {
      return {
        acceptedInput,
        providerInput,
        outputModalities: [],
        transforms,
        fallbackUsed,
        rejectionReason: "No compatible output modalities after negotiation",
      };
    }
  }

  return {
    acceptedInput,
    providerInput,
    outputModalities: outputSelection.selected,
    transforms,
    fallbackUsed,
  };
}

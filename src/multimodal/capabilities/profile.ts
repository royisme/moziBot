import type { ContentPart, Modality } from "../protocol/index.ts";

export interface ModalityLimits {
  enabled: boolean;
  maxBytes?: number;
  maxDurationMs?: number;
  acceptedMimeTypes?: string[];
}

export interface CapabilityProfile {
  id: string;
  kind: "channel" | "provider" | "policy";
  input: Record<Modality, ModalityLimits>;
  output: Record<Modality, ModalityLimits>;
  streaming?: {
    input: boolean;
    output: boolean;
  };
  updatedAt: string;
}

export interface NegotiationRuntimeConstraints {
  maxTotalBytes: number;
  latencyBudgetMs?: number;
}

export interface NegotiationInput {
  requestedInput: ContentPart[];
  requestedOutputModalities: Modality[];
  channelProfile: CapabilityProfile;
  providerProfile: CapabilityProfile;
  policyProfile: CapabilityProfile;
  runtime: NegotiationRuntimeConstraints;
}

export interface TransformStep {
  type: "transcode" | "extract-text" | "summarize" | "thumbnail" | "drop";
  from: Modality;
  to: Modality;
  reason: string;
}

export interface DeliveryPlan {
  acceptedInput: ContentPart[];
  providerInput: ContentPart[];
  outputModalities: Modality[];
  transforms: TransformStep[];
  fallbackUsed: boolean;
  rejectionReason?: string;
}

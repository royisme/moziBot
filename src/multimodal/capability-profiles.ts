import type { ModelSpec } from "../runtime/types";
import type { CapabilityProfile, ModalityLimits } from "./capabilities";

type ModalityProfile = Record<"text" | "image" | "audio" | "video" | "file", ModalityLimits>;

const ENABLED: ModalityLimits = { enabled: true };
const DISABLED: ModalityLimits = { enabled: false };

function buildModelProfileInput(spec?: ModelSpec): ModalityProfile {
  const supported = new Set(spec?.input ?? ["text"]);
  return {
    text: supported.has("text") ? ENABLED : DISABLED,
    image: supported.has("image") ? ENABLED : DISABLED,
    audio: supported.has("audio") ? ENABLED : DISABLED,
    video: supported.has("video") ? ENABLED : DISABLED,
    file: supported.has("file") ? ENABLED : DISABLED,
  };
}

export function buildChannelCapabilityProfile(channel: {
  id: string;
  supportsStreamingOutput: boolean;
}): CapabilityProfile {
  const id = `channel:${channel.id}`;
  if (channel.id === "telegram") {
    return {
      id,
      kind: "channel",
      input: {
        text: ENABLED,
        image: ENABLED,
        audio: ENABLED,
        video: ENABLED,
        file: ENABLED,
      },
      output: {
        text: ENABLED,
        image: ENABLED,
        audio: ENABLED,
        video: DISABLED,
        file: ENABLED,
      },
      streaming: { input: true, output: channel.supportsStreamingOutput },
      updatedAt: new Date().toISOString(),
    };
  }

  if (channel.id === "discord") {
    return {
      id,
      kind: "channel",
      input: {
        text: ENABLED,
        image: ENABLED,
        audio: ENABLED,
        video: ENABLED,
        file: ENABLED,
      },
      output: {
        text: ENABLED,
        image: ENABLED,
        audio: DISABLED,
        video: DISABLED,
        file: ENABLED,
      },
      streaming: { input: true, output: channel.supportsStreamingOutput },
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    id,
    kind: "channel",
    input: {
      text: ENABLED,
      image: ENABLED,
      audio: ENABLED,
      video: ENABLED,
      file: ENABLED,
    },
    output: {
      text: ENABLED,
      image: ENABLED,
      audio: DISABLED,
      video: DISABLED,
      file: ENABLED,
    },
    streaming: { input: true, output: false },
    updatedAt: new Date().toISOString(),
  };
}

export function buildProviderCapabilityProfile(
  modelRef: string,
  modelSpec?: ModelSpec,
): CapabilityProfile {
  return {
    id: `provider:${modelRef}`,
    kind: "provider",
    input: buildModelProfileInput(modelSpec),
    output: {
      text: ENABLED,
      image: DISABLED,
      audio: DISABLED,
      video: DISABLED,
      file: DISABLED,
    },
    streaming: { input: true, output: true },
    updatedAt: new Date().toISOString(),
  };
}

export function buildPolicyCapabilityProfile(maxTotalBytes: number): CapabilityProfile {
  return {
    id: "policy:default",
    kind: "policy",
    input: {
      text: ENABLED,
      image: { enabled: true, maxBytes: maxTotalBytes },
      audio: { enabled: true, maxBytes: maxTotalBytes },
      video: { enabled: true, maxBytes: maxTotalBytes },
      file: { enabled: true, maxBytes: maxTotalBytes },
    },
    output: {
      text: ENABLED,
      image: ENABLED,
      audio: ENABLED,
      video: ENABLED,
      file: ENABLED,
    },
    streaming: { input: true, output: true },
    updatedAt: new Date().toISOString(),
  };
}

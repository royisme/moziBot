import type { MoziConfig } from "../../../config";
import type { TtsResult } from "../types";

type VoiceTtsConfig = NonNullable<NonNullable<MoziConfig["voice"]>["tts"]>;

const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
  speed: 1,
} as const;

function resolveMimeType(format: "mp3_22050_32" | "pcm_16000" | undefined) {
  if (format === "pcm_16000") {
    return "audio/wav" as const;
  }
  return "audio/mpeg" as const;
}

export async function elevenLabsTts(
  text: string,
  config: VoiceTtsConfig["elevenlabs"] | undefined,
): Promise<TtsResult> {
  const apiKey = config?.apiKey?.trim();
  if (!apiKey) {
    throw new Error("elevenlabs TTS apiKey is missing");
  }

  const voiceId = config?.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID;
  const modelId = config?.modelId ?? DEFAULT_ELEVENLABS_MODEL_ID;
  const format: "mp3_22050_32" | "pcm_16000" = config?.format ?? "mp3_22050_32";
  const timeoutMs = config?.timeoutMs ?? 20_000;
  const voiceSettings = {
    stability: config?.voiceSettings?.stability ?? DEFAULT_VOICE_SETTINGS.stability,
    similarityBoost:
      config?.voiceSettings?.similarityBoost ?? DEFAULT_VOICE_SETTINGS.similarityBoost,
    style: config?.voiceSettings?.style ?? DEFAULT_VOICE_SETTINGS.style,
    useSpeakerBoost:
      config?.voiceSettings?.useSpeakerBoost ?? DEFAULT_VOICE_SETTINGS.useSpeakerBoost,
    speed: config?.voiceSettings?.speed ?? DEFAULT_VOICE_SETTINGS.speed,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`);
    url.searchParams.set("output_format", format);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        apply_text_normalization: config?.applyTextNormalization,
        language_code: config?.languageCode,
        voice_settings: {
          stability: voiceSettings.stability,
          similarity_boost: voiceSettings.similarityBoost,
          style: voiceSettings.style,
          use_speaker_boost: voiceSettings.useSpeakerBoost,
          speed: voiceSettings.speed,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`elevenlabs TTS API error (${response.status})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new Error("elevenlabs TTS returned empty audio buffer");
    }

    return {
      provider: "elevenlabs",
      mimeType: resolveMimeType(format),
      buffer,
      voice: voiceId,
    };
  } finally {
    clearTimeout(timeout);
  }
}

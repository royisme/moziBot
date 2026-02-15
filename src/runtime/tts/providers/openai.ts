import type { MoziConfig } from "../../../config";
import type { TtsResult } from "../types";

type VoiceTtsConfig = NonNullable<NonNullable<MoziConfig["voice"]>["tts"]>;

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_VOICE = "alloy";

function resolveMimeType(format: "mp3" | "wav" | undefined) {
  if (format === "wav") {
    return "audio/wav" as const;
  }
  return "audio/mpeg" as const;
}

export async function openAiTts(
  text: string,
  config: VoiceTtsConfig["openai"] | undefined,
): Promise<TtsResult> {
  const apiKey = config?.apiKey?.trim();
  if (!apiKey) {
    throw new Error("openai TTS apiKey is missing");
  }

  const model = config?.model ?? DEFAULT_OPENAI_MODEL;
  const voice = config?.voice ?? DEFAULT_OPENAI_VOICE;
  const format: "mp3" | "wav" = config?.format ?? "mp3";
  const timeoutMs = config?.timeoutMs ?? 20_000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: format,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`openai TTS API error (${response.status})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new Error("openai TTS returned empty audio buffer");
    }

    return {
      provider: "openai",
      mimeType: resolveMimeType(format),
      buffer,
      voice,
    };
  } finally {
    clearTimeout(timeout);
  }
}

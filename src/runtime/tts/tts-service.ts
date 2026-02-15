import type { MoziConfig } from "../../config";
import type { TtsProvider, TtsResult } from "./types";
import { logger } from "../../logger";
import { edgeTts } from "./providers/edge";
import { elevenLabsTts } from "./providers/elevenlabs";
import { openAiTts } from "./providers/openai";

type VoiceTtsConfig = NonNullable<NonNullable<MoziConfig["voice"]>["tts"]>;

const DEFAULT_PROVIDER_ORDER: TtsProvider[] = ["edge"];
const DEFAULT_MAX_CHARS = 1500;

export class TtsService {
  constructor(private config: MoziConfig) {}

  updateConfig(config: MoziConfig): void {
    this.config = config;
  }

  async textToSpeech(
    text: string,
    _opts?: {
      agentId?: string;
      peerId?: string;
    },
  ): Promise<TtsResult> {
    const normalizedText = this.normalizeText(text);
    if (!normalizedText) {
      throw new Error("TTS input text is empty");
    }

    const tts = this.config.voice?.tts;
    const providers = this.resolveProviderOrder(tts);
    const errors: Error[] = [];

    for (const provider of providers) {
      try {
        const result = await this.callProvider(provider, normalizedText, tts);
        if (result.buffer.byteLength === 0) {
          throw new Error(`${provider} provider returned empty audio buffer`);
        }
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          {
            provider,
            textLength: normalizedText.length,
            error: err.message,
          },
          "TTS provider failed",
        );
        errors.push(new Error(`[${provider}] ${err.message}`));
      }
    }

    throw new AggregateError(errors, "All TTS providers failed");
  }

  private normalizeText(text: string): string {
    const maxChars = this.config.voice?.tts?.maxChars ?? DEFAULT_MAX_CHARS;
    const trimmed = text.trim();
    if (trimmed.length <= maxChars) {
      return trimmed;
    }
    return trimmed.slice(0, maxChars);
  }

  private resolveProviderOrder(tts: VoiceTtsConfig | undefined): TtsProvider[] {
    const requested = tts?.providerOrder?.length ? tts.providerOrder : DEFAULT_PROVIDER_ORDER;
    return requested.filter((provider) => this.isProviderEnabled(provider, tts));
  }

  private isProviderEnabled(provider: TtsProvider, tts: VoiceTtsConfig | undefined): boolean {
    if (!tts) {
      return provider === "edge";
    }
    if (provider === "edge") {
      return tts.edge?.enabled !== false;
    }
    if (provider === "openai") {
      return tts.openai?.enabled === true;
    }
    return tts.elevenlabs?.enabled === true;
  }

  private callProvider(
    provider: TtsProvider,
    text: string,
    tts: VoiceTtsConfig | undefined,
  ): Promise<TtsResult> {
    if (provider === "edge") {
      return edgeTts(text, tts?.edge);
    }
    if (provider === "openai") {
      return openAiTts(text, tts?.openai);
    }
    return elevenLabsTts(text, tts?.elevenlabs);
  }
}

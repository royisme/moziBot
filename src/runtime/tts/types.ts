export type TtsProvider = "edge" | "openai" | "elevenlabs";

export type TtsMimeType = "audio/mpeg" | "audio/wav";

export type TtsResult = {
  provider: TtsProvider;
  mimeType: TtsMimeType;
  buffer: Buffer;
  durationMs?: number;
  voice?: string;
};

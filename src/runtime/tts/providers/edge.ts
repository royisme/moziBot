import { EdgeTTS } from "node-edge-tts";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MoziConfig } from "../../../config";
import type { TtsResult } from "../types";

type VoiceTtsConfig = NonNullable<NonNullable<MoziConfig["voice"]>["tts"]>;

const DEFAULT_EDGE_VOICE = "en-US-AriaNeural";
const DEFAULT_EDGE_FORMAT = "audio-24khz-48kbitrate-mono-mp3" as const;

function resolveMimeType(format: NonNullable<VoiceTtsConfig["edge"]>["format"] | undefined) {
  if (format === "riff-24khz-16bit-mono-pcm") {
    return "audio/wav" as const;
  }
  return "audio/mpeg" as const;
}

export async function edgeTts(
  text: string,
  config: VoiceTtsConfig["edge"] | undefined,
): Promise<TtsResult> {
  const configuredFormat = config?.format ?? DEFAULT_EDGE_FORMAT;

  try {
    return await synthesizeEdge(text, config, configuredFormat);
  } catch {
    if (configuredFormat !== DEFAULT_EDGE_FORMAT) {
      return await synthesizeEdge(text, config, DEFAULT_EDGE_FORMAT);
    }
    throw new Error("edge-tts synthesis failed");
  }
}

async function synthesizeEdge(
  text: string,
  config: VoiceTtsConfig["edge"] | undefined,
  format: NonNullable<VoiceTtsConfig["edge"]>["format"] | typeof DEFAULT_EDGE_FORMAT,
): Promise<TtsResult> {
  const mimeType = resolveMimeType(format);
  const outputExt = mimeType === "audio/wav" ? "wav" : "mp3";
  const dir = await mkdtemp(path.join(tmpdir(), "mozi-tts-edge-"));
  const outputPath = path.join(dir, `edge-tts-${randomUUID()}.${outputExt}`);

  try {
    const tts = new EdgeTTS({
      voice: config?.voice ?? DEFAULT_EDGE_VOICE,
      outputFormat: format,
      rate: config?.rate,
      pitch: config?.pitch,
    });
    await tts.ttsPromise(text, outputPath);
    const buffer = await readFile(outputPath);
    if (buffer.byteLength === 0) {
      throw new Error("edge-tts returned empty audio buffer");
    }
    return {
      provider: "edge",
      mimeType,
      buffer,
      voice: config?.voice ?? DEFAULT_EDGE_VOICE,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

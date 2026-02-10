import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { MoziConfig } from "../../config";
import { logger } from "../../logger";
import type { InboundMessage, MediaAttachment } from "../adapters/channels/types";

type VoiceSttConfig = NonNullable<NonNullable<MoziConfig["voice"]>["stt"]>;
type RemoteSttConfig = NonNullable<VoiceSttConfig["remote"]>;

type PreparedAudio = {
  filePath: string;
  mimeType: string;
  cleanup?: () => Promise<void>;
};

export class SttService {
  constructor(private config: MoziConfig) {}

  updateConfig(config: MoziConfig): void {
    this.config = config;
  }

  async transcribeInboundMessage(message: InboundMessage): Promise<string | null> {
    const stt = this.config.voice?.stt;
    if (!stt) {
      return null;
    }

    const audio = (message.media ?? []).find((item) => item.type === "audio" || item.type === "voice");
    if (!audio) {
      return null;
    }

    const strategy = stt.strategy ?? "local-first";
    if (strategy === "remote-only") {
      return await this.transcribeRemote(audio, stt.remote);
    }

    if (strategy === "local-only") {
      return await this.transcribeLocal(audio, stt.local);
    }

    const local = await this.transcribeLocal(audio, stt.local).catch((error) => {
      logger.warn({ err: error }, "Local STT failed; will try remote fallback if configured");
      return null;
    });
    if (local) {
      return local;
    }
    return await this.transcribeRemote(audio, stt.remote);
  }

  private async transcribeLocal(
    audio: MediaAttachment,
    local: VoiceSttConfig["local"],
  ): Promise<string | null> {
    if (!local) {
      return null;
    }

    const prepared = await this.prepareAudio(audio);
    if (!prepared) {
      return null;
    }

    try {
      await access(local.modelPath);

      const args: string[] = ["-m", local.modelPath, "-f", prepared.filePath];
      if (typeof local.language === "string" && local.language.trim()) {
        args.push("-l", local.language.trim());
      }
      if (typeof local.threads === "number" && Number.isFinite(local.threads)) {
        args.push("-t", String(local.threads));
      }

      const timeoutMs = local.timeoutMs ?? 20_000;
      const cmd = local.binPath ?? "whisper-cli";
      const { stdout } = await execa(cmd, args, {
        timeout: timeoutMs,
        reject: false,
      });

      return this.cleanTranscript(stdout);
    } finally {
      if (prepared.cleanup) {
        await prepared.cleanup();
      }
    }
  }

  private async transcribeRemote(
    audio: MediaAttachment,
    remote: VoiceSttConfig["remote"],
  ): Promise<string | null> {
    if (!remote) {
      return null;
    }

    const prepared = await this.prepareAudio(audio);
    if (!prepared) {
      return null;
    }

    try {
      const fileBuffer = await readFile(prepared.filePath);
      const fileName = path.basename(prepared.filePath) || `audio-${randomUUID()}.wav`;
      const blob = new Blob([fileBuffer], { type: prepared.mimeType });
      const form = new FormData();
      form.append("file", blob, fileName);

      if (remote.model) {
        form.append("model", remote.model);
      }
      if (this.config.voice?.stt?.local?.language) {
        form.append("language", this.config.voice.stt.local.language);
      }

      const headers = new Headers(remote.headers ?? {});
      if (remote.apiKey) {
        headers.set("authorization", `Bearer ${remote.apiKey}`);
      }

      const endpoint = this.resolveRemoteEndpoint(remote.provider, remote.endpoint);
      const timeoutMs = remote.timeoutMs ?? 20_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: form,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as Record<string, unknown>;
      return this.extractRemoteTranscript(data);
    } finally {
      if (prepared.cleanup) {
        await prepared.cleanup();
      }
    }
  }

  private resolveRemoteEndpoint(provider: RemoteSttConfig["provider"], endpoint?: string): string {
    if (endpoint) {
      return endpoint;
    }
    if (provider === "openai") {
      return "https://api.openai.com/v1/audio/transcriptions";
    }
    if (provider === "groq") {
      return "https://api.groq.com/openai/v1/audio/transcriptions";
    }
    if (provider === "deepgram") {
      return "https://api.deepgram.com/v1/listen";
    }
    return "http://127.0.0.1:8080/transcribe";
  }

  private extractRemoteTranscript(data: Record<string, unknown>): string | null {
    if (typeof data.text === "string" && data.text.trim()) {
      return data.text.trim();
    }
    const results = data.results;
    if (!results || typeof results !== "object") {
      return null;
    }
    const channels = (results as { channels?: unknown }).channels;
    if (!Array.isArray(channels) || channels.length === 0) {
      return null;
    }
    const firstChannel = channels[0];
    if (!firstChannel || typeof firstChannel !== "object") {
      return null;
    }
    const alternatives = (firstChannel as { alternatives?: unknown }).alternatives;
    if (!Array.isArray(alternatives) || alternatives.length === 0) {
      return null;
    }
    const first = alternatives[0];
    if (!first || typeof first !== "object") {
      return null;
    }
    const transcript = (first as { transcript?: unknown }).transcript;
    return typeof transcript === "string" && transcript.trim() ? transcript.trim() : null;
  }

  private cleanTranscript(stdout: string): string | null {
    const text = stdout
      .replaceAll(/\[[^\]]*-->[^\]]*\]/g, "")
      .replaceAll(/\s+/g, " ")
      .trim();
    return text.length > 0 ? text : null;
  }

  private async prepareAudio(audio: MediaAttachment): Promise<PreparedAudio | null> {
    const dir = await mkdtemp(path.join(tmpdir(), "mozi-stt-"));
    const cleanup = async () => {
      await rm(dir, { recursive: true, force: true });
    };

    try {
      let inputPath: string;

      if (audio.path) {
        inputPath = audio.path;
      } else if (audio.buffer && audio.buffer.byteLength > 0) {
        inputPath = path.join(dir, `input-${randomUUID()}`);
        await writeFile(inputPath, audio.buffer);
      } else if (audio.url && /^https?:\/\//.test(audio.url)) {
        const response = await fetch(audio.url);
        if (!response.ok) {
          await cleanup();
          return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        inputPath = path.join(dir, `input-${randomUUID()}`);
        await writeFile(inputPath, Buffer.from(arrayBuffer));
      } else {
        await cleanup();
        return null;
      }

      const outputPath = path.join(dir, `output-${randomUUID()}.wav`);

      // Convert to Whisper-compatible WAV (16kHz, mono, 16-bit PCM)
      // This ensures consistent performance across different audio sources/formats
      await execa("ffmpeg", [
        "-i",
        inputPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        outputPath,
        "-y",
      ]);

      return {
        filePath: outputPath,
        mimeType: "audio/wav",
        cleanup,
      };
    } catch (error) {
      logger.error({ error, audioUrl: audio.url }, "Failed to prepare or convert audio for STT");
      await cleanup();
      return null;
    }
  }
}

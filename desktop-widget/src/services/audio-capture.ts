/**
/**
 * Captures microphone audio, frames it as PCM s16le, and sends
 * audio_chunk / audio_commit messages via the provided callbacks.
 *
 * Uses AudioWorklet for off-main-thread processing.
 */
export class AudioCaptureService {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private streamId = "";
  private seq = 0;
  private capturing = false;
  private vadConfig: VadConfig = { ...DEFAULT_VAD_CONFIG };
  private vadStartedAt = 0;
  private vadLastSpeechAt = 0;
  private vadHasSpeech = false;
  private vadStopTriggered = false;

  onChunk:
    | ((streamId: string, seq: number, sampleRate: number, chunkBase64: string) => void)
    | null = null;
  onCommit: ((streamId: string, totalChunks: number, reason: string) => void) | null = null;
  onLevel: ((level: number) => void) | null = null;
  onVadStop: ((reason: VadStopReason) => void) | null = null;

  configureVad(options: Partial<VadConfig>): void {
    this.vadConfig = { ...this.vadConfig, ...options };
  }

  async start(): Promise<void> {
    if (this.capturing) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    await this.audioContext.audioWorklet.addModule("/pcm-worklet-processor.js");

    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(this.audioContext, "pcm-worklet-processor");

    this.streamId = crypto.randomUUID();
    this.seq = 0;
    this.capturing = true;
    this.resetVadState();

    const handleMessage = (e: MessageEvent<ArrayBuffer>) => {
      if (!this.capturing) return;
      const pcmBuffer = e.data;
      const pcmView = new Int16Array(pcmBuffer);
      const level = computeRmsLevel(pcmView);
      this.onLevel?.(level);
      this.handleVad(level);
      const base64 = uint8ArrayToBase64(new Uint8Array(pcmBuffer));
      this.onChunk?.(this.streamId, this.seq, 16000, base64);
      this.seq++;
    };
    this.workletNode.port.addEventListener("message", handleMessage);
    this.workletNode.port.start();

    this.source.connect(this.workletNode);
    this.workletNode.connect(this.audioContext.destination);
  }

  stop(reason: "manual_stop" | "vad_silence" | "max_duration" = "manual_stop"): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.onLevel?.(0);
    this.resetVadState();

    this.onCommit?.(this.streamId, this.seq, reason);

    this.workletNode?.disconnect();
    this.source?.disconnect();
    this.workletNode = null;
    this.source = null;

    if (this.audioContext?.state !== "closed") {
      void this.audioContext?.close();
    }
    this.audioContext = null;

    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  destroy(): void {
    this.stop();
    this.onChunk = null;
    this.onCommit = null;
    this.onLevel = null;
    this.onVadStop = null;
  }

  private resetVadState(): void {
    this.vadStartedAt = Date.now();
    this.vadLastSpeechAt = this.vadStartedAt;
    this.vadHasSpeech = false;
    this.vadStopTriggered = false;
  }

  private handleVad(level: number): void {
    if (!this.vadConfig.enabled || this.vadStopTriggered) {
      return;
    }
    const now = Date.now();
    const { threshold, silenceMs, minActiveMs, maxDurationMs } = this.vadConfig;

    if (level >= threshold) {
      this.vadHasSpeech = true;
      this.vadLastSpeechAt = now;
    }

    const elapsed = now - this.vadStartedAt;
    if (elapsed >= maxDurationMs) {
      this.vadStopTriggered = true;
      this.onVadStop?.("max_duration");
      return;
    }

    if (!this.vadHasSpeech) {
      return;
    }

    if (elapsed < minActiveMs) {
      return;
    }

    if (now - this.vadLastSpeechAt >= silenceMs) {
      this.vadStopTriggered = true;
      this.onVadStop?.("vad_silence");
    }
  }
}

type VadStopReason = "vad_silence" | "max_duration";

type VadConfig = {
  enabled: boolean;
  threshold: number;
  silenceMs: number;
  minActiveMs: number;
  maxDurationMs: number;
};

const DEFAULT_VAD_CONFIG: VadConfig = {
  enabled: false,
  threshold: 0.02,
  silenceMs: 900,
  minActiveMs: 500,
  maxDurationMs: 15000,
};

function computeRmsLevel(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const normalized = samples[i] / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples.length);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

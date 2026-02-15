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

  onChunk: ((streamId: string, seq: number, sampleRate: number, chunkBase64: string) => void) | null = null;
  onCommit: ((streamId: string, totalChunks: number, reason: string) => void) | null = null;

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

    this.workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (!this.capturing) return;
      const base64 = uint8ArrayToBase64(new Uint8Array(e.data));
      this.onChunk?.(this.streamId, this.seq, 16000, base64);
      this.seq++;
    };

    this.source.connect(this.workletNode);
    this.workletNode.connect(this.audioContext.destination);
  }

  stop(reason: "manual_stop" | "vad_silence" | "max_duration" = "manual_stop"): void {
    if (!this.capturing) return;
    this.capturing = false;

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
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

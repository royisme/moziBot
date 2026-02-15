/**
 * Assembles incoming TTS audio chunks into a playable blob URL.
 * For Live2D mode, the blob URL is passed to `model.speak()` for built-in lip sync.
 * For orb mode (or as fallback), plays via HTMLAudioElement directly.
 */
export class AudioPlaybackService {
  private pendingChunks = new Map<string, string[]>();
  private pendingMeta = new Map<
    string,
    { mimeType: string; durationMs: number; text: string }
  >();
  private currentAudio: HTMLAudioElement | null = null;

  onAudioReady: ((streamId: string, blobUrl: string, mimeType: string) => void) | null = null;

  handleAudioMeta(
    streamId: string,
    mimeType: string,
    durationMs: number,
    text: string,
  ): void {
    this.pendingMeta.set(streamId, { mimeType, durationMs, text });
    if (!this.pendingChunks.has(streamId)) {
      this.pendingChunks.set(streamId, []);
    }
  }

  handleAudioChunk(streamId: string, chunkBase64: string, isLast: boolean): void {
    let chunks = this.pendingChunks.get(streamId);
    if (!chunks) {
      chunks = [];
      this.pendingChunks.set(streamId, chunks);
    }
    chunks.push(chunkBase64);

    if (isLast) {
      this.assembleAndEmit(streamId);
    }
  }

  /**
   * Fallback playback for orb mode (no Live2D speak).
   */
  playBlobUrl(blobUrl: string): void {
    this.stopCurrent();
    this.currentAudio = new Audio(blobUrl);
    this.currentAudio.addEventListener("ended", () => {
      URL.revokeObjectURL(blobUrl);
      this.currentAudio = null;
    });
    void this.currentAudio.play();
  }

  stopCurrent(): void {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
  }

  destroy(): void {
    this.stopCurrent();
    this.pendingChunks.clear();
    this.pendingMeta.clear();
    this.onAudioReady = null;
  }

  private assembleAndEmit(streamId: string): void {
    const chunks = this.pendingChunks.get(streamId);
    const meta = this.pendingMeta.get(streamId);
    this.pendingChunks.delete(streamId);
    this.pendingMeta.delete(streamId);

    if (!chunks || chunks.length === 0) return;

    const binaryChunks = chunks.map((b64) => base64ToUint8Array(b64));
    const totalLength = binaryChunks.reduce((sum, c) => sum + c.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of binaryChunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const mimeType = meta?.mimeType ?? "audio/mpeg";
    const blob = new Blob([combined], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);

    this.onAudioReady?.(streamId, blobUrl, mimeType);
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

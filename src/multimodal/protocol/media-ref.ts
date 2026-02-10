export interface MediaRef {
  mediaId: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  durationMs?: number;
  width?: number;
  height?: number;
  filename?: string;
}

import type { MediaRef } from "./media-ref.ts";

export type Modality = "text" | "image" | "audio" | "video" | "file";

export type PartRole = "user" | "assistant" | "system" | "tool";

export interface BasePart {
  id: string;
  role: PartRole;
  index: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface TextPart extends BasePart {
  modality: "text";
  text: string;
  format?: "plain" | "markdown";
}

export interface ImagePart extends BasePart {
  modality: "image";
  media: MediaRef;
  altText?: string;
}

export interface AudioPart extends BasePart {
  modality: "audio";
  media: MediaRef;
  transcript?: string;
}

export interface VideoPart extends BasePart {
  modality: "video";
  media: MediaRef;
  transcript?: string;
}

export interface FilePart extends BasePart {
  modality: "file";
  media: MediaRef;
  extractedText?: string;
}

export type ContentPart = TextPart | ImagePart | AudioPart | VideoPart | FilePart;

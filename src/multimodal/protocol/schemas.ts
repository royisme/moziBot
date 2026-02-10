import { z } from "zod";
import { CANONICAL_PROTOCOL_VERSION } from "./versioning.ts";

export const MediaRefSchema = z.object({
  mediaId: z.string().min(1),
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  durationMs: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  filename: z.string().min(1).optional(),
});

export const MetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

const BasePartShape = {
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool"]),
  index: z.number().int().nonnegative(),
  metadata: MetadataSchema.optional(),
};

export const TextPartSchema = z.object({
  ...BasePartShape,
  modality: z.literal("text"),
  text: z.string(),
  format: z.enum(["plain", "markdown"]).optional(),
});

export const ImagePartSchema = z.object({
  ...BasePartShape,
  modality: z.literal("image"),
  media: MediaRefSchema,
  altText: z.string().optional(),
});

export const AudioPartSchema = z.object({
  ...BasePartShape,
  modality: z.literal("audio"),
  media: MediaRefSchema,
  transcript: z.string().optional(),
});

export const VideoPartSchema = z.object({
  ...BasePartShape,
  modality: z.literal("video"),
  media: MediaRefSchema,
  transcript: z.string().optional(),
});

export const FilePartSchema = z.object({
  ...BasePartShape,
  modality: z.literal("file"),
  media: MediaRefSchema,
  extractedText: z.string().optional(),
});

export const ContentPartSchema = z.discriminatedUnion("modality", [
  TextPartSchema,
  ImagePartSchema,
  AudioPartSchema,
  VideoPartSchema,
  FilePartSchema,
]);

export const CanonicalEnvelopeSchema = z.object({
  id: z.string().min(1),
  protocolVersion: z.literal(CANONICAL_PROTOCOL_VERSION),
  tenantId: z.string().min(1),
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  direction: z.enum(["inbound", "outbound"]),
  source: z.object({
    channel: z.enum(["telegram", "discord", "api"]),
    channelMessageId: z.string().min(1),
    userId: z.string().min(1),
  }),
  parts: z.array(ContentPartSchema),
  createdAt: z.iso.datetime(),
  correlationId: z.string().min(1),
  traceId: z.string().min(1),
});

export type MediaRefInput = z.infer<typeof MediaRefSchema>;
export type ContentPartInput = z.infer<typeof ContentPartSchema>;
export type CanonicalEnvelopeInput = z.infer<typeof CanonicalEnvelopeSchema>;

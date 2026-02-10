import { createHash, randomUUID } from "node:crypto";
import type { InboundMessage, MediaAttachment } from "../runtime/adapters/channels/types";
import type { ModelSpec } from "../runtime/types";
import { logger } from "../logger";
import { isDbInitialized, multimodal } from "../storage/db";
import {
  negotiateDeliveryPlan,
  type DeliveryPlan,
  type NegotiationInput,
} from "./capabilities/index.ts";
import {
  buildChannelCapabilityProfile,
  buildPolicyCapabilityProfile,
  buildProviderCapabilityProfile,
} from "./capability-profiles";
import {
  CANONICAL_PROTOCOL_VERSION,
  type CanonicalEnvelope,
  type ContentPart,
  type Modality,
} from "./protocol/index.ts";

function hashHex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function nowIso(date?: Date): string {
  return (date ?? new Date()).toISOString();
}

function mapMediaToModality(media: MediaAttachment): Exclude<Modality, "text"> {
  if (media.type === "photo") {
    return "image";
  }
  if (media.type === "video") {
    return "video";
  }
  if (media.type === "audio" || media.type === "voice") {
    return "audio";
  }
  return "file";
}

function buildMediaHash(message: InboundMessage, media: MediaAttachment, index: number): string {
  const payload = JSON.stringify({
    channel: message.channel,
    messageId: message.id,
    mediaIndex: index,
    type: media.type,
    url: media.url,
    path: media.path,
    filename: media.filename,
    mimeType: media.mimeType,
    caption: media.caption,
    size: media.buffer?.byteLength,
  });
  return hashHex(payload);
}

function buildParts(message: InboundMessage): ContentPart[] {
  const parts: ContentPart[] = [];
  let idx = 0;
  const text = message.text?.trim() ?? "";
  if (text) {
    parts.push({
      id: `${message.id}:part:${idx}`,
      role: "user",
      index: idx,
      modality: "text",
      text,
      format: "plain",
    });
    idx += 1;
  }

  for (const [mediaIndex, media] of (message.media ?? []).entries()) {
    const sha256 = buildMediaHash(message, media, mediaIndex);
    const mediaId = `media:${sha256.slice(0, 24)}`;
    const mimeType = media.mimeType ?? "application/octet-stream";
    const byteSize = media.byteSize ?? media.buffer?.byteLength ?? 0;
    const common = {
      id: `${message.id}:part:${idx}`,
      role: "user" as const,
      index: idx,
      metadata: {
        sourceUrl: media.url ?? null,
        sourcePath: media.path ?? null,
        caption: media.caption ?? null,
      },
      media: {
        mediaId,
        mimeType,
        byteSize,
        sha256,
        durationMs: media.durationMs,
        width: media.width,
        height: media.height,
        filename: media.filename,
      },
    };

    const modality = mapMediaToModality(media);
    if (modality === "image") {
      parts.push({ ...common, modality: "image", altText: media.caption });
    } else if (modality === "audio") {
      parts.push({ ...common, modality: "audio" });
    } else if (modality === "video") {
      parts.push({ ...common, modality: "video" });
    } else {
      parts.push({ ...common, modality: "file" });
    }
    idx += 1;
  }

  return parts;
}

function buildNegotiationInput(params: {
  parts: ContentPart[];
  channelId: string;
  modelRef: string;
  modelSpec?: ModelSpec;
}): NegotiationInput {
  const maxTotalBytes = 25 * 1024 * 1024;
  return {
    requestedInput: params.parts,
    requestedOutputModalities: ["text"],
    channelProfile: buildChannelCapabilityProfile({
      id: params.channelId,
      supportsStreamingOutput: false,
    }),
    providerProfile: buildProviderCapabilityProfile(params.modelRef, params.modelSpec),
    policyProfile: buildPolicyCapabilityProfile(maxTotalBytes),
    runtime: {
      maxTotalBytes,
    },
  };
}

function inferBlobUri(params: {
  sourcePath?: string;
  sourceUrl?: string;
  channel: string;
  messageId: string;
  mediaId: string;
}): string {
  if (params.sourcePath) {
    return `file://${params.sourcePath}`;
  }
  if (params.sourceUrl) {
    return params.sourceUrl;
  }
  return `inline://${params.channel}/${params.messageId}/${params.mediaId}/${randomUUID()}`;
}

export function buildCanonicalEnvelope(params: {
  message: InboundMessage;
  sessionKey: string;
}): CanonicalEnvelope {
  const { message, sessionKey } = params;
  return {
    id: `${message.channel}:${message.id}`,
    protocolVersion: CANONICAL_PROTOCOL_VERSION,
    tenantId: "default",
    conversationId: sessionKey,
    messageId: message.id,
    direction: "inbound",
    source: {
      channel:
        message.channel === "telegram" || message.channel === "discord" ? message.channel : "api",
      channelMessageId: message.id,
      userId: message.senderId,
    },
    parts: buildParts(message),
    createdAt: nowIso(message.timestamp),
    correlationId: `${message.channel}:${message.id}`,
    traceId: hashHex(`${sessionKey}:${message.id}`).slice(0, 32),
  };
}

export function persistInboundEnvelope(params: {
  envelope: CanonicalEnvelope;
  raw: unknown;
  channelId: string;
  modelRef: string;
  modelSpec?: ModelSpec;
}): DeliveryPlan {
  const { envelope, raw } = params;
  const planInput = buildNegotiationInput({
    parts: envelope.parts,
    channelId: params.channelId,
    modelRef: params.modelRef,
    modelSpec: params.modelSpec,
  });
  const plan = negotiateDeliveryPlan(planInput);

  multimodal.createMessage({
    id: envelope.id,
    protocol_version: envelope.protocolVersion,
    tenant_id: envelope.tenantId,
    conversation_id: envelope.conversationId,
    message_id: envelope.messageId,
    direction: envelope.direction,
    source_channel: envelope.source.channel,
    source_channel_message_id: envelope.source.channelMessageId,
    source_user_id: envelope.source.userId,
    correlation_id: envelope.correlationId,
    trace_id: envelope.traceId,
    created_at: envelope.createdAt,
  });

  for (const part of envelope.parts) {
    if (part.modality === "text") {
      continue;
    }
    const media = part.media;
    multimodal.upsertMediaAsset({
      id: media.mediaId,
      tenant_id: envelope.tenantId,
      sha256: media.sha256,
      mime_type: media.mimeType,
      byte_size: media.byteSize,
      duration_ms: media.durationMs ?? null,
      width: media.width ?? null,
      height: media.height ?? null,
      filename: media.filename ?? null,
      blob_uri: inferBlobUri({
        sourcePath:
          typeof part.metadata?.sourcePath === "string" ? part.metadata.sourcePath : undefined,
        sourceUrl:
          typeof part.metadata?.sourceUrl === "string" ? part.metadata.sourceUrl : undefined,
        channel: envelope.source.channel,
        messageId: envelope.messageId,
        mediaId: media.mediaId,
      }),
      scan_status: "pending",
      created_at: envelope.createdAt,
    });
  }

  const parts = envelope.parts.map((part) => ({
    id: part.id,
    message_id: envelope.id,
    idx: part.index,
    role: part.role,
    modality: part.modality,
    text: part.modality === "text" ? part.text : null,
    media_id: part.modality === "text" ? null : part.media.mediaId,
    metadata_json: part.metadata ? JSON.stringify(part.metadata) : null,
    created_at: envelope.createdAt,
  }));
  multimodal.createMessageParts(parts);

  multimodal.createCapabilitySnapshot({
    id: `${envelope.id}:capability`,
    message_id: envelope.id,
    channel_profile_json: JSON.stringify(planInput.channelProfile),
    provider_profile_json: JSON.stringify(planInput.providerProfile),
    policy_profile_json: JSON.stringify(planInput.policyProfile),
    plan_json: JSON.stringify(plan),
    created_at: envelope.createdAt,
  });

  multimodal.upsertRawEvent({
    id: `${envelope.id}:raw`,
    channel: envelope.source.channel,
    event_id: envelope.source.channelMessageId,
    payload_json: JSON.stringify(raw ?? {}),
    received_at: envelope.createdAt,
  });

  return plan;
}

export function ingestInboundMessage(params: {
  message: InboundMessage;
  sessionKey: string;
  channelId: string;
  modelRef: string;
  modelSpec?: ModelSpec;
}): DeliveryPlan | null {
  const { message, sessionKey } = params;
  if (!isDbInitialized()) {
    return null;
  }
  try {
    const envelope = buildCanonicalEnvelope({ message, sessionKey });
    return persistInboundEnvelope({
      envelope,
      raw: message.raw,
      channelId: params.channelId,
      modelRef: params.modelRef,
      modelSpec: params.modelSpec,
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        channel: message.channel,
        messageId: message.id,
      },
      "Failed to ingest inbound multimodal envelope",
    );
    return null;
  }
}

import type {
  MultimodalMessage,
  MultimodalMessagePart,
  MultimodalMediaAsset,
  MultimodalDeliveryAttempt,
  MultimodalCapabilitySnapshot,
  MultimodalRawEvent,
} from "../types";
import { withConnection } from "../connection";

export const multimodal = {
  createMessage: (message: MultimodalMessage) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO multimodal_messages (id, protocol_version, tenant_id, conversation_id, message_id, direction, source_channel, source_channel_message_id, source_user_id, correlation_id, trace_id, created_at) VALUES ($id, $protocol_version, $tenant_id, $conversation_id, $message_id, $direction, $source_channel, $source_channel_message_id, $source_user_id, $correlation_id, $trace_id, $created_at)`,
        )
        .run(message),
    ),
  createMessageParts: (
    parts: Array<Omit<MultimodalMessagePart, "created_at"> & { created_at?: string }>,
  ) =>
    withConnection((conn) => {
      const stmt = conn.prepare(
        `INSERT INTO multimodal_message_parts (id, message_id, idx, role, modality, text, media_id, metadata_json, created_at) VALUES ($id, $message_id, $idx, $role, $modality, $text, $media_id, $metadata_json, $created_at)`,
      );
      const now = new Date().toISOString();
      for (const part of parts) {
        stmt.run({
          ...part,
          created_at: part.created_at ?? now,
        });
      }
    }),
  upsertMediaAsset: (asset: MultimodalMediaAsset) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO multimodal_media_assets (id, tenant_id, sha256, mime_type, byte_size, duration_ms, width, height, filename, blob_uri, scan_status, created_at) VALUES ($id, $tenant_id, $sha256, $mime_type, $byte_size, $duration_ms, $width, $height, $filename, $blob_uri, $scan_status, $created_at) ON CONFLICT(sha256) DO UPDATE SET mime_type = excluded.mime_type, byte_size = excluded.byte_size, duration_ms = excluded.duration_ms, width = excluded.width, height = excluded.height, filename = excluded.filename, blob_uri = excluded.blob_uri, scan_status = excluded.scan_status`,
        )
        .run(asset),
    ),
  createDeliveryAttempt: (attempt: MultimodalDeliveryAttempt) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO multimodal_delivery_attempts (id, message_id, channel, attempt_no, status, error_code, error_detail, sent_at) VALUES ($id, $message_id, $channel, $attempt_no, $status, $error_code, $error_detail, $sent_at)`,
        )
        .run(attempt),
    ),
  createCapabilitySnapshot: (snapshot: MultimodalCapabilitySnapshot) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO multimodal_capability_snapshots (id, message_id, channel_profile_json, provider_profile_json, policy_profile_json, plan_json, created_at) VALUES ($id, $message_id, $channel_profile_json, $provider_profile_json, $policy_profile_json, $plan_json, $created_at)`,
        )
        .run(snapshot),
    ),
  upsertRawEvent: (event: MultimodalRawEvent) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO multimodal_raw_events (id, channel, event_id, payload_json, received_at) VALUES ($id, $channel, $event_id, $payload_json, $received_at) ON CONFLICT(channel, event_id) DO UPDATE SET payload_json = excluded.payload_json, received_at = excluded.received_at`,
        )
        .run(event),
    ),
};

export interface Message {
  id: string;
  channel: string;
  chat_id: string;
  sender_id: string;
  content: string;
  timestamp: string;
  created_at?: string;
}

export interface Group {
  id: string;
  channel: string;
  chat_id: string;
  name: string;
  folder: string;
  is_main: number;
  created_at?: string;
}

export interface Task {
  id: string;
  group_id: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  last_run: string | null;
  next_run: string | null;
  created_at?: string;
}

export type RuntimeQueueStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "interrupted";

export interface RuntimeQueueItem {
  id: string;
  dedup_key: string;
  session_key: string;
  channel_id: string;
  peer_id: string;
  peer_type: string;
  inbound_json: string;
  status: RuntimeQueueStatus;
  attempts: number;
  error: string | null;
  enqueued_at: string;
  available_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface ReminderRecord {
  id: string;
  session_key: string;
  channel_id: string;
  peer_id: string;
  peer_type: string;
  message: string;
  schedule_kind: "at" | "every" | "cron";
  schedule_json: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthSecret {
  name: string;
  scope_type: "global" | "agent";
  scope_id: string;
  value_ciphertext: Buffer;
  value_nonce: Buffer;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  created_by: string | null;
}

export interface MultimodalMessage {
  id: string;
  protocol_version: string;
  tenant_id: string;
  conversation_id: string;
  message_id: string;
  direction: "inbound" | "outbound";
  source_channel: string;
  source_channel_message_id: string;
  source_user_id: string;
  correlation_id: string;
  trace_id: string;
  created_at: string;
}

export interface MultimodalMessagePart {
  id: string;
  message_id: string;
  idx: number;
  role: string;
  modality: string;
  text: string | null;
  media_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface MultimodalMediaAsset {
  id: string;
  tenant_id: string;
  sha256: string;
  mime_type: string;
  byte_size: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  filename: string | null;
  blob_uri: string;
  scan_status: string;
  created_at: string;
}

export interface MultimodalDeliveryAttempt {
  id: string;
  message_id: string;
  channel: string;
  attempt_no: number;
  status: string;
  error_code: string | null;
  error_detail: string | null;
  sent_at: string;
}

export interface MultimodalCapabilitySnapshot {
  id: string;
  message_id: string;
  channel_profile_json: string;
  provider_profile_json: string;
  policy_profile_json: string;
  plan_json: string;
  created_at: string;
}

export interface MultimodalRawEvent {
  id: string;
  channel: string;
  event_id: string;
  payload_json: string;
  received_at: string;
}

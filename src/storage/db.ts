// Facade: re-exports all storage components so existing import paths continue to work.
// e.g. import { sessions, runtimeQueue, initDb } from "./storage/db"

export {
  isDbInitialized,
  initDb,
  acquireConnection,
  releaseConnection,
  withConnection,
  closeDb,
} from "./connection";

export type {
  Message,
  Group,
  Task,
  RuntimeQueueStatus,
  RuntimeQueueItem,
  ReminderRecord,
  AuthSecret,
  MultimodalMessage,
  MultimodalMessagePart,
  MultimodalMediaAsset,
  MultimodalDeliveryAttempt,
  MultimodalCapabilitySnapshot,
  MultimodalRawEvent,
} from "./types";

export { sessions } from "./repos/sessions";
export { runtimeQueue } from "./repos/runtime-queue";
export { authSecrets } from "./repos/auth-secrets";
export { reminders } from "./repos/reminders";
export { messages } from "./repos/messages";
export { groups } from "./repos/groups";
export { tasks } from "./repos/tasks";
export { multimodal } from "./repos/multimodal";

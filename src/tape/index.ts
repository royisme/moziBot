export * from './types.js';
export { TapeFile } from './tape-file.js';
export { TapeStore } from './tape-store.js';
export { TapeService } from './tape-service.js';
export { selectMessages } from './tape-context.js';
export type { TapeMessage } from './tape-context.js';

// Integration layer - bridge between tape system and moziBot runtime
export {
  createTapeStore,
  createTapeService,
  buildMessagesFromTape,
  buildAllMessages,
  recordTurnToTape,
  compactViaTape,
  withForkTape,
} from './integration.js';

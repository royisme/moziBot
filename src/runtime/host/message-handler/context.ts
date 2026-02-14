import type { MessageTurnContext } from './contract';
import type { MessageTurnInput } from './types';

export function createMessageTurnContext(message: MessageTurnInput): MessageTurnContext {
  return {
    messageId: message.id,
    type: message.type,
    payload: message.payload,
    startTime: Date.now(),
    state: {},
  };
}

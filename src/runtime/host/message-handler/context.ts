import type { MessageTurnContext } from "./contract";
import type { MessageTurnInput } from "./types";

export function createMessageTurnContext(message: MessageTurnInput): MessageTurnContext {
  const traceId = `turn:${message.id}`;
  return {
    messageId: message.id,
    traceId,
    type: message.type,
    payload: message.payload,
    startTime: Date.now(),
    state: {},
  };
}

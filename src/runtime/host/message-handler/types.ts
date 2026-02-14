/**
 * Message-handler turn types
 * Strict typing only, no 'any'.
 */

export interface MessageTurnInput {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
}

export interface MessageTurnResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

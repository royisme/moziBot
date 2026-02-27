import type { TapeEntry } from './types.js';

/** Message format compatible with LLM APIs */
export interface TapeMessage {
  role: string;
  content: string;
  tool_calls?: Record<string, unknown>[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Convert tape entries into LLM-compatible messages.
 * - kind=message -> { role, content } from payload
 * - kind=tool_call -> { role: 'assistant', content: '', tool_calls: payload.calls }
 * - kind=tool_result -> one message per result: { role: 'tool', content, tool_call_id?, name? }
 * - kind=system -> { role: 'system', content: payload.content }
 * - kind=anchor, kind=event -> skipped (internal bookkeeping)
 */
export function selectMessages(entries: TapeEntry[]): TapeMessage[] {
  const messages: TapeMessage[] = [];
  let savedToolCalls: Record<string, unknown>[] | null = null;

  for (const entry of entries) {
    switch (entry.kind) {
      case 'message': {
        const role = entry.payload.role as string;
        const content = entry.payload.content as string;
        messages.push({ role, content });
        break;
      }

      case 'tool_call': {
        savedToolCalls = entry.payload.calls as Record<string, unknown>[];
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: savedToolCalls,
        });
        break;
      }

      case 'tool_result': {
        const results = entry.payload.results as Record<string, unknown>[];
        if (Array.isArray(results)) {
          for (let i = 0; i < results.length; i++) {
            const result = results[i];
            // Try to pair with previous tool_call by index
            let tool_call_id: string | undefined;
            let name: string | undefined;

            if (savedToolCalls && savedToolCalls[i]) {
              const call = savedToolCalls[i] as Record<string, unknown>;
              const func = call.function as Record<string, unknown> | undefined;
              tool_call_id = call.id as string | undefined;
              name = func?.name as string | undefined;
            }

            // Convert result to string content
            const content = typeof result === 'string'
              ? result
              : JSON.stringify(result);

            messages.push({
              role: 'tool',
              content,
              tool_call_id,
              name,
            });
          }
        }
        // Clear saved tool calls after processing results
        savedToolCalls = null;
        break;
      }

      case 'system': {
        const content = entry.payload.content as string;
        messages.push({ role: 'system', content });
        break;
      }

      case 'anchor':
      case 'event':
        // Skip internal bookkeeping entries
        break;
    }
  }

  return messages;
}

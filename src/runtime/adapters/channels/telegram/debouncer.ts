import type { InboundMessage } from "../types";

interface PendingGroup {
  messages: InboundMessage[];
  timer: ReturnType<typeof setTimeout> | null;
}

export class MediaGroupDebouncer {
  private pending = new Map<string, PendingGroup>();
  private readonly windowMs: number;

  constructor(windowMs = 500) {
    this.windowMs = windowMs;
  }

  add(groupId: string, message: InboundMessage, emit: (msg: InboundMessage) => void): void {
    const existing = this.pending.get(groupId);

    if (existing) {
      if (existing.timer) {
        clearTimeout(existing.timer);
      }
      existing.messages.push(message);
    } else {
      this.pending.set(groupId, { messages: [message], timer: null });
    }

    const group = this.pending.get(groupId)!;
    group.timer = setTimeout(() => {
      this.pending.delete(groupId);
      const merged = this.merge(group.messages);
      emit(merged);
    }, this.windowMs);
  }

  private merge(messages: InboundMessage[]): InboundMessage {
    // Use first message as base
    const base = messages[0];
    // Collect all media from all messages
    const allMedia = messages.flatMap((m) => m.media ?? []);
    return {
      ...base,
      media: allMedia.length > 0 ? allMedia : undefined,
      // Use combined text (usually caption from first)
      text: messages.find((m) => m.text)?.text ?? base.text,
    };
  }
}

import type { ContinuationRequest } from "./contracts";

export class ContinuationRegistry {
  private pending = new Map<string, ContinuationRequest[]>();

  schedule(sessionKey: string, request: ContinuationRequest): void {
    const existing = this.pending.get(sessionKey) ?? [];
    existing.push(request);
    this.pending.set(sessionKey, existing);
  }

  consume(sessionKey: string): ContinuationRequest[] {
    const requests = this.pending.get(sessionKey) ?? [];
    this.pending.delete(sessionKey);
    return requests;
  }

  hasPending(sessionKey: string): boolean {
    return (this.pending.get(sessionKey)?.length ?? 0) > 0;
  }

  clear(sessionKey: string): void {
    this.pending.delete(sessionKey);
  }

  clearAll(): void {
    this.pending.clear();
  }
}

export const continuationRegistry = new ContinuationRegistry();

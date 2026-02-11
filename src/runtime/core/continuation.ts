import type { ContinuationRequest } from "./contracts";

export class ContinuationRegistry {
  private pending = new Map<string, ContinuationRequest[]>();
  private cancelledSessions = new Set<string>();

  schedule(sessionKey: string, request: ContinuationRequest): boolean {
    if (this.cancelledSessions.has(sessionKey)) {
      return false;
    }
    const existing = this.pending.get(sessionKey) ?? [];
    existing.push(request);
    this.pending.set(sessionKey, existing);
    return true;
  }

  consume(sessionKey: string): ContinuationRequest[] {
    if (this.cancelledSessions.has(sessionKey)) {
      this.pending.delete(sessionKey);
      return [];
    }
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

  cancelSession(sessionKey: string): void {
    this.cancelledSessions.add(sessionKey);
    this.pending.delete(sessionKey);
  }

  resumeSession(sessionKey: string): void {
    this.cancelledSessions.delete(sessionKey);
  }

  isSessionCancelled(sessionKey: string): boolean {
    return this.cancelledSessions.has(sessionKey);
  }

  clearAll(): void {
    this.pending.clear();
    this.cancelledSessions.clear();
  }
}

export const continuationRegistry = new ContinuationRegistry();

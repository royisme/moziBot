import { TapeStore } from "./tape-store.js";
import type { TapeEntry, TapeEntryKind, AnchorPayload, AnchorSummary, TapeInfo } from "./types.js";
import {
  createMessage,
  createToolCall,
  createToolResult,
  createAnchor,
  createEvent,
  createSystem,
} from "./types.js";

export class TapeService {
  constructor(
    private readonly tapeName: string,
    private readonly store: TapeStore,
  ) {}

  // --- Core append operations ---

  appendMessage(role: string, content: string, meta?: Record<string, unknown>): TapeEntry {
    return this.store.append(this.tapeName, createMessage(role, content, meta));
  }

  appendToolCall(calls: Record<string, unknown>[], meta?: Record<string, unknown>): TapeEntry {
    return this.store.append(this.tapeName, createToolCall(calls, meta));
  }

  appendToolResult(results: unknown[], meta?: Record<string, unknown>): TapeEntry {
    return this.store.append(this.tapeName, createToolResult(results, meta));
  }

  appendEvent(name: string, data: Record<string, unknown>): TapeEntry {
    return this.store.append(this.tapeName, createEvent(name, data));
  }

  appendSystem(content: string): TapeEntry {
    return this.store.append(this.tapeName, createSystem(content));
  }

  // --- Anchor / Handoff ---

  handoff(name: string, state?: AnchorPayload["state"]): TapeEntry {
    return this.store.append(this.tapeName, createAnchor(name, state));
  }

  ensureBootstrapAnchor(): void {
    const entries = this.store.read(this.tapeName);
    if (entries && entries.some((e) => e.kind === "anchor")) {
      return;
    }
    this.handoff("session/start", { owner: "human" });
  }

  // --- Fork / Merge ---

  /** Fork the tape. Returns fork name and a restore function to discard the fork. */
  forkTape(): { forkName: string; restore: () => void } {
    const forkName = this.store.fork(this.tapeName);
    return {
      forkName,
      restore: () => {
        this.store.reset(forkName);
      },
    };
  }

  mergeFork(forkName: string): void {
    this.store.merge(forkName, this.tapeName);
  }

  // --- Queries ---

  info(): TapeInfo {
    const entries = this.store.read(this.tapeName) ?? [];
    const anchors = entries.filter((e) => e.kind === "anchor");
    const lastAnchor =
      anchors.length > 0 ? ((anchors[anchors.length - 1].payload.name as string) ?? null) : null;
    const lastAnchorId = anchors.length > 0 ? anchors[anchors.length - 1].id : 0;
    const entriesSinceLastAnchor =
      lastAnchorId > 0 ? entries.filter((e) => e.id > lastAnchorId).length : entries.length;

    return {
      name: this.tapeName,
      entries: entries.length,
      anchors: anchors.length,
      lastAnchor,
      entriesSinceLastAnchor,
    };
  }

  anchors(limit: number = 20): AnchorSummary[] {
    const entries = this.store.read(this.tapeName) ?? [];
    const anchorEntries = entries.filter((e) => e.kind === "anchor");
    return anchorEntries.slice(-limit).map((e) => ({
      name: (e.payload.name as string) ?? "-",
      state: (e.payload.state as Record<string, unknown>) ?? {},
    }));
  }

  /** Get all entries after the last anchor, optionally filtered by kinds. */
  fromLastAnchor(kinds?: TapeEntryKind[]): TapeEntry[] {
    const entries = this.store.read(this.tapeName) ?? [];
    const anchors = entries.filter((e) => e.kind === "anchor");
    const lastAnchorId = anchors.length > 0 ? anchors[anchors.length - 1].id : 0;
    let result = entries.filter((e) => e.id > lastAnchorId);
    if (kinds && kinds.length > 0) {
      result = result.filter((e) => kinds.includes(e.kind));
    }
    return result;
  }

  /** Get entries between two named anchors. */
  betweenAnchors(startName: string, endName: string, kinds?: TapeEntryKind[]): TapeEntry[] {
    const entries = this.store.read(this.tapeName) ?? [];
    const anchors = entries.filter((e) => e.kind === "anchor");
    const startAnchor = anchors.find((e) => e.payload.name === startName);
    const endAnchor = [...anchors].toReversed().find((e) => e.payload.name === endName);
    if (!startAnchor || !endAnchor) {
      return [];
    }
    let result = entries.filter((e) => e.id > startAnchor.id && e.id < endAnchor.id);
    if (kinds && kinds.length > 0) {
      result = result.filter((e) => kinds.includes(e.kind));
    }
    return result;
  }

  /** Get entries after a named anchor. */
  afterAnchor(anchorName: string, kinds?: TapeEntryKind[]): TapeEntry[] {
    const entries = this.store.read(this.tapeName) ?? [];
    const anchors = entries.filter((e) => e.kind === "anchor");
    const anchor = [...anchors].toReversed().find((e) => e.payload.name === anchorName);
    if (!anchor) {
      return [];
    }
    let result = entries.filter((e) => e.id > anchor.id);
    if (kinds && kinds.length > 0) {
      result = result.filter((e) => kinds.includes(e.kind));
    }
    return result;
  }

  /** Simple text search across tape entry payloads. */
  search(query: string, limit: number = 20): TapeEntry[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [];
    }
    const entries = this.store.read(this.tapeName) ?? [];
    const results: TapeEntry[] = [];
    // Search in reverse (newest first)
    for (let i = entries.length - 1; i >= 0 && results.length < limit; i--) {
      const entry = entries[i];
      const text = JSON.stringify(entry.payload).toLowerCase();
      if (text.includes(normalized)) {
        results.push(entry);
      }
    }
    return results;
  }

  /** Read all entries, or null if tape doesn't exist. */
  readAll(): TapeEntry[] | null {
    return this.store.read(this.tapeName);
  }
}

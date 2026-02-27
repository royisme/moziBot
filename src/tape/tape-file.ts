import { existsSync, unlinkSync, renameSync, appendFileSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TapeEntry } from './types.js';

export class TapeFile {
  private _readEntries: TapeEntry[] = [];
  private _readOffset: number = 0;
  private _nextIdCache: number | null = null;

  constructor(public readonly filePath: string) {}

  read(): TapeEntry[] {
    if (!existsSync(this.filePath)) {
      this._readEntries = [];
      this._readOffset = 0;
      this._nextIdCache = null;
      return [];
    }

    // Read entire file on first call or if offset is 0 and we have no entries
    if (this._readOffset === 0 && this._readEntries.length === 0) {
      const content = readFileSync(this.filePath, 'utf-8');
      if (content) {
        const lines = content.split('\n').filter((line) => line.trim() !== '');
        const entries: TapeEntry[] = [];
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as TapeEntry;
            if (this._isValidEntry(entry)) {
              entries.push(entry);
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
        this._readEntries = entries;
        this._readOffset = Buffer.byteLength(content, 'utf-8');
        this._nextIdCache = entries.length > 0 ? entries[entries.length - 1].id + 1 : 1;
      } else {
        this._readEntries = [];
        this._readOffset = 0;
        this._nextIdCache = 1;
      }
    } else {
      // Incremental read - read only new bytes
      const currentSize = statSync(this.filePath).size;
      if (currentSize > this._readOffset) {
        // Read as Buffer and slice by byte offset to handle multi-byte UTF-8 correctly
        const buffer = readFileSync(this.filePath);
        const newBuffer = buffer.subarray(this._readOffset);
        const newContent = newBuffer.toString('utf-8');
        const lines = newContent.split('\n').filter((line) => line.trim() !== '');
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as TapeEntry;
            if (this._isValidEntry(entry)) {
              this._readEntries.push(entry);
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
        this._readOffset = currentSize;
        if (this._readEntries.length > 0) {
          this._nextIdCache = this._readEntries[this._readEntries.length - 1].id + 1;
        } else {
          this._nextIdCache = 1;
        }
      }
    }

    return [...this._readEntries];
  }

  append(entry: Omit<TapeEntry, 'id'>): TapeEntry {
    return this._appendInternal(entry);
  }

  appendMany(entries: Omit<TapeEntry, 'id'>[]): TapeEntry[] {
    const result: TapeEntry[] = [];
    for (const entry of entries) {
      result.push(this._appendInternal(entry));
    }
    return result;
  }

  private _appendInternal(entry: Omit<TapeEntry, 'id'>): TapeEntry {
    const id = this._nextId();
    const fullEntry: TapeEntry = {
      ...entry,
      id,
    };

    // Ensure directory exists
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Append to file
    const line = JSON.stringify(fullEntry) + '\n';
    appendFileSync(this.filePath, line, 'utf-8');

    // Update internal state
    this._readEntries.push(fullEntry);
    this._readOffset += Buffer.byteLength(line, 'utf-8');
    this._nextIdCache = id + 1;

    return fullEntry;
  }

  reset(): void {
    if (existsSync(this.filePath)) {
      unlinkSync(this.filePath);
    }
    this._readEntries = [];
    this._readOffset = 0;
    this._nextIdCache = null;
  }

  archive(): string | null {
    if (!existsSync(this.filePath)) {
      return null;
    }

    // Generate timestamp
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '').slice(0, 17) + 'Z';
    const newPath = `${this.filePath}.${timestamp}.bak`;

    renameSync(this.filePath, newPath);

    // Reset internal state
    this._readEntries = [];
    this._readOffset = 0;
    this._nextIdCache = null;

    return newPath;
  }

  copyTo(target: TapeFile): { forkStartId: number } {
    const entries = this.read();
    const forkStartId = entries.length > 0 ? entries[entries.length - 1].id + 1 : 1;

    // Ensure target directory exists
    const targetDir = dirname(target.filePath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    // Write all entries to target
    for (const entry of entries) {
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(target.filePath, line, 'utf-8');
    }

    // Let target build its own internal state by reading the file
    target.read();

    return { forkStartId };
  }

  copyFrom(source: TapeFile, fromId: number): void {
    const sourceEntries = source.read();
    const filteredEntries = sourceEntries.filter((entry) => entry.id >= fromId);

    for (const entry of filteredEntries) {
      const { id, ...entryWithoutId } = entry;
      this._appendInternal(entryWithoutId);
    }
  }

  private _nextId(): number {
    if (this._nextIdCache !== null) {
      return this._nextIdCache;
    }

    // Read file to get max ID
    const entries = this.read();
    if (entries.length > 0) {
      this._nextIdCache = entries[entries.length - 1].id + 1;
    } else {
      this._nextIdCache = 1;
    }
    return this._nextIdCache;
  }

  private _isValidEntry(entry: unknown): entry is TapeEntry {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e.id === 'number' &&
      typeof e.kind === 'string' &&
      ['message', 'tool_call', 'tool_result', 'anchor', 'event', 'system'].includes(e.kind) &&
      typeof e.payload === 'object' &&
      e.payload !== null &&
      typeof e.meta === 'object' &&
      e.meta !== null
    );
  }
}

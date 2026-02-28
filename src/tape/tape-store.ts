import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { TapeFile } from './tape-file.js';
import type { TapeEntry } from './types.js';

export class TapeStore {
  private readonly workspaceHash: string;
  private readonly _tapeFiles: Map<string, TapeFile> = new Map();

  constructor(
    public readonly tapesDir: string,
    public readonly workspacePath: string
  ) {
    // Compute workspace hash (first 16 chars of MD5 hex)
    const hash = createHash('md5').update(workspacePath).digest('hex');
    this.workspaceHash = hash.slice(0, 16);

    // Ensure tapes directory exists
    if (!existsSync(tapesDir)) {
      mkdirSync(tapesDir, { recursive: true });
    }
  }

  private _encodeName(name: string): string {
    return encodeURIComponent(name);
  }

  private _decodeName(encoded: string): string {
    return decodeURIComponent(encoded);
  }

  private _getFilePath(name: string): string {
    return `${this.tapesDir}/${this.workspaceHash}__${this._encodeName(name)}.tape.jsonl`;
  }

  list(): string[] {
    if (!existsSync(this.tapesDir)) {
      return [];
    }

    const files = readdirSync(this.tapesDir);
    const names = new Set<string>();

    for (const file of files) {
      // Match files with pattern: {workspaceHash}__{name}.tape.jsonl
      const match = file.match(new RegExp(`^${this.workspaceHash}__(.+)\\.tape\\.jsonl$`));
      if (match) {
        names.add(this._decodeName(match[1]));
      }
    }

    return Array.from(names).sort();
  }

  getTapeFile(name: string): TapeFile {
    const cached = this._tapeFiles.get(name);
    if (cached) {
      return cached;
    }

    const tapeFile = new TapeFile(this._getFilePath(name));
    this._tapeFiles.set(name, tapeFile);
    return tapeFile;
  }

  fork(sourceName: string): string {
    const forkName = `${sourceName}__fork_${this._randomHex(8)}`;

    const sourceFile = this.getTapeFile(sourceName);
    const targetFile = this.getTapeFile(forkName);

    sourceFile.copyTo(targetFile);

    return forkName;
  }

  merge(sourceName: string, targetName: string): void {
    const sourceFile = this.getTapeFile(sourceName);
    const targetFile = this.getTapeFile(targetName);

    // Get target entries to determine the ID threshold
    // We only want to copy entries from source that have IDs greater than
    // what target already has (i.e., entries added after fork was created)
    const targetEntries = targetFile.read();
    const fromId = targetEntries.length > 0 ? targetEntries[targetEntries.length - 1].id + 1 : 1;

    // Copy entries from source to target starting from fromId
    targetFile.copyFrom(sourceFile, fromId);

    // Delete source file and remove from cache
    sourceFile.reset();
    this._tapeFiles.delete(sourceName);
  }

  reset(name: string): void {
    const tapeFile = this.getTapeFile(name);
    tapeFile.reset();
    this._tapeFiles.delete(name);
  }

  archive(name: string): string | null {
    const tapeFile = this.getTapeFile(name);
    const result = tapeFile.archive();
    if (result) {
      this._tapeFiles.delete(name);
    }
    return result;
  }

  read(name: string): TapeEntry[] | null {
    const filePath = this._getFilePath(name);
    if (!existsSync(filePath)) {
      return null;
    }
    const tapeFile = this.getTapeFile(name);
    return tapeFile.read();
  }

  append(name: string, entry: Omit<TapeEntry, 'id'>): TapeEntry {
    const tapeFile = this.getTapeFile(name);
    return tapeFile.append(entry);
  }

  private _randomHex(length: number): string {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  }
}

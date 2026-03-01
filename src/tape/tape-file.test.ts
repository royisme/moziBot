import { mkdtempSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TapeFile } from "./tape-file.js";

describe("TapeFile", () => {
  let tempDir: string;
  let tapeFile: TapeFile;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tape-test-"));
    tapeFile = new TapeFile(join(tempDir, "test.tape.jsonl"));
  });

  afterEach(() => {
    // Cleanup is handled by mkdtempSync creating unique directories
  });

  it("should append entries and read them back with sequential IDs", () => {
    const entry1 = tapeFile.append({
      kind: "message",
      payload: { role: "user", content: "Hello" },
      meta: {},
    });

    const entry2 = tapeFile.append({
      kind: "message",
      payload: { role: "assistant", content: "Hi there" },
      meta: {},
    });

    expect(entry1.id).toBe(1);
    expect(entry2.id).toBe(2);

    const entries = tapeFile.read();
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(1);
    expect(entries[1].id).toBe(2);
  });

  it("should support incremental reads", () => {
    // First read - empty
    let entries = tapeFile.read();
    expect(entries).toHaveLength(0);

    // Append 2 entries
    tapeFile.append({
      kind: "message",
      payload: { role: "user", content: "Hello" },
      meta: {},
    });
    tapeFile.append({
      kind: "message",
      payload: { role: "assistant", content: "Hi" },
      meta: {},
    });

    // Read should have 2 entries
    entries = tapeFile.read();
    expect(entries).toHaveLength(2);

    // Append 2 more entries
    tapeFile.append({
      kind: "message",
      payload: { role: "user", content: "How are you?" },
      meta: {},
    });
    tapeFile.append({
      kind: "message",
      payload: { role: "assistant", content: "Good" },
      meta: {},
    });

    // Read again should have all 4 entries
    entries = tapeFile.read();
    expect(entries).toHaveLength(4);
    expect(entries[0].payload.content).toBe("Hello");
    expect(entries[3].payload.content).toBe("Good");
  });

  it("should return empty array for nonexistent file", () => {
    const emptyFile = new TapeFile(join(tempDir, "nonexistent.tape.jsonl"));
    const entries = emptyFile.read();
    expect(entries).toHaveLength(0);
  });

  it("should skip invalid JSON lines", () => {
    // Manually write some invalid lines
    appendFileSync(tapeFile.filePath, "not valid json\n", "utf-8");
    appendFileSync(
      tapeFile.filePath,
      '{"id": 1, "kind": "message", "payload": {}, "meta": {}}\n',
      "utf-8",
    );
    appendFileSync(tapeFile.filePath, "also not valid\n", "utf-8");

    const entries = tapeFile.read();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(1);
  });

  it("should reset and clear file", () => {
    tapeFile.append({
      kind: "message",
      payload: { role: "user", content: "Hello" },
      meta: {},
    });

    expect(existsSync(tapeFile.filePath)).toBe(true);

    tapeFile.reset();

    expect(existsSync(tapeFile.filePath)).toBe(false);
    const entries = tapeFile.read();
    expect(entries).toHaveLength(0);
  });

  it("should archive and rename file with timestamp", () => {
    tapeFile.append({
      kind: "message",
      payload: { role: "user", content: "Hello" },
      meta: {},
    });

    const archivedPath = tapeFile.archive();

    expect(archivedPath).not.toBeNull();
    expect(archivedPath).toContain(".bak");
    expect(existsSync(tapeFile.filePath)).toBe(false);
    expect(existsSync(archivedPath!)).toBe(true);
  });

  it("should return null when archiving nonexistent file", () => {
    const emptyFile = new TapeFile(join(tempDir, "nonexistent.tape.jsonl"));
    const result = emptyFile.archive();
    expect(result).toBeNull();
  });

  it("should copy to another TapeFile", () => {
    tapeFile.append({
      kind: "message",
      payload: { role: "user", content: "Hello" },
      meta: {},
    });
    tapeFile.append({
      kind: "message",
      payload: { role: "assistant", content: "Hi" },
      meta: {},
    });

    const targetPath = join(tempDir, "fork.tape.jsonl");
    const targetFile = new TapeFile(targetPath);

    const result = tapeFile.copyTo(targetFile);

    expect(result.forkStartId).toBe(3);

    const targetEntries = targetFile.read();
    expect(targetEntries).toHaveLength(2);
    expect(targetEntries[0].id).toBe(1);
    expect(targetEntries[1].id).toBe(2);
  });

  it("should copy from another TapeFile with fromId", () => {
    const sourcePath = join(tempDir, "source.tape.jsonl");
    const sourceFile = new TapeFile(sourcePath);

    sourceFile.append({
      kind: "message",
      payload: { role: "user", content: "Hello" },
      meta: {},
    });
    sourceFile.append({
      kind: "message",
      payload: { role: "assistant", content: "Hi" },
      meta: {},
    });
    sourceFile.append({
      kind: "message",
      payload: { role: "user", content: "How are you?" },
      meta: {},
    });

    // Copy from ID 2 (should include entries with id >= 2)
    tapeFile.copyFrom(sourceFile, 2);

    const entries = tapeFile.read();
    expect(entries).toHaveLength(2);
    expect(entries[0].payload.content).toBe("Hi");
    expect(entries[1].payload.content).toBe("How are you?");
  });

  it("should support appendMany for batch operations", () => {
    const entries = tapeFile.appendMany([
      {
        kind: "message",
        payload: { role: "user", content: "Hello" },
        meta: {},
      },
      {
        kind: "message",
        payload: { role: "assistant", content: "Hi" },
        meta: {},
      },
      {
        kind: "message",
        payload: { role: "user", content: "How are you?" },
        meta: {},
      },
    ]);

    expect(entries).toHaveLength(3);
    expect(entries[0].id).toBe(1);
    expect(entries[1].id).toBe(2);
    expect(entries[2].id).toBe(3);

    const readEntries = tapeFile.read();
    expect(readEntries).toHaveLength(3);
  });
});

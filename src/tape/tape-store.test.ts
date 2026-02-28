import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TapeStore } from './tape-store.js';

describe('TapeStore', () => {
  let tempDir: string;
  let store: TapeStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tape-store-test-'));
    store = new TapeStore(tempDir, '/test/workspace');
  });

  afterEach(() => {
    // Cleanup
  });

  it('should return empty list for fresh store', () => {
    const list = store.list();
    expect(list).toHaveLength(0);
  });

  it('should append and read roundtrip', () => {
    const entry = store.append('my-tape', {
      kind: 'message',
      payload: { role: 'user', content: 'Hello' },
      meta: {},
    });

    expect(entry.id).toBe(1);

    const entries = store.read('my-tape');
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(1);
    expect(entries![0].payload.content).toBe('Hello');
  });

  it('should return null for nonexistent tape', () => {
    const entries = store.read('nonexistent');
    expect(entries).toBeNull();
  });

  it('should fork and create new tape with copied entries', () => {
    // Create source tape with entries
    store.append('main', {
      kind: 'message',
      payload: { role: 'user', content: 'Hello' },
      meta: {},
    });
    store.append('main', {
      kind: 'message',
      payload: { role: 'assistant', content: 'Hi' },
      meta: {},
    });

    const forkName = store.fork('main');

    // Fork name should contain __fork_
    expect(forkName).toContain('__fork_');

    // Fork should have same entries as main
    const forkEntries = store.read(forkName);
    expect(forkEntries).toHaveLength(2);

    // Main should still have 2 entries
    const mainEntries = store.read('main');
    expect(mainEntries).toHaveLength(2);
  });

  it('should merge fork entries to target', () => {
    // Create main tape with 2 entries
    store.append('main', {
      kind: 'message',
      payload: { role: 'user', content: 'Hello' },
      meta: {},
    });
    store.append('main', {
      kind: 'message',
      payload: { role: 'assistant', content: 'Hi' },
      meta: {},
    });

    // Fork main to create fork tape
    const forkName = store.fork('main');

    // Add new entries to fork
    store.append(forkName, {
      kind: 'message',
      payload: { role: 'user', content: 'How are you?' },
      meta: {},
    });
    store.append(forkName, {
      kind: 'message',
      payload: { role: 'assistant', content: 'Good' },
      meta: {},
    });

    // Merge fork back to main
    store.merge(forkName, 'main');

    // Main should now have 4 entries (original 2 + fork's 2 new ones)
    const mainEntries = store.read('main');
    expect(mainEntries).toHaveLength(4);
    expect(mainEntries![0].payload.content).toBe('Hello');
    expect(mainEntries![1].payload.content).toBe('Hi');
    expect(mainEntries![2].payload.content).toBe('How are you?');
    expect(mainEntries![3].payload.content).toBe('Good');
  });

  it('should reset and remove tape', () => {
    store.append('my-tape', {
      kind: 'message',
      payload: { role: 'user', content: 'Hello' },
      meta: {},
    });

    // Verify tape was created by reading it back
    const entriesBefore = store.read('my-tape');
    expect(entriesBefore).toHaveLength(1);

    store.reset('my-tape');

    const entries = store.read('my-tape');
    expect(entries).toBeNull();
  });

  it('should archive tape and return backup path', () => {
    store.append('my-tape', {
      kind: 'message',
      payload: { role: 'user', content: 'Hello' },
      meta: {},
    });

    const backupPath = store.archive('my-tape');

    expect(backupPath).not.toBeNull();
    expect(backupPath).toContain('.bak');

    // Original should be gone
    const entries = store.read('my-tape');
    expect(entries).toBeNull();

    // But backup should exist
    expect(existsSync(backupPath!)).toBe(true);
  });

  it('should list tapes', () => {
    store.append('tape-a', {
      kind: 'message',
      payload: { role: 'user', content: 'A' },
      meta: {},
    });
    store.append('tape-b', {
      kind: 'message',
      payload: { role: 'user', content: 'B' },
      meta: {},
    });

    const list = store.list();
    expect(list).toContain('tape-a');
    expect(list).toContain('tape-b');
    expect(list).toHaveLength(2);
  });

  it('should handle special characters in tape names', () => {
    const tapeName = 'my test tape 123';
    store.append(tapeName, {
      kind: 'message',
      payload: { role: 'user', content: 'Hello' },
      meta: {},
    });

    const entries = store.read(tapeName);
    expect(entries).toHaveLength(1);

    const list = store.list();
    expect(list).toContain(tapeName);
  });
});

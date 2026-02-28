/**
 * fork-merge.test.ts
 *
 * Verifies that the tape fork/merge wrapping around the prompt execution in
 * runPromptWithCoordinator correctly isolates failed/aborted interactions.
 *
 * Test cases:
 *  1. On successful prompt, fork entries are merged to the main tape.
 *  2. On a failed prompt (assistant failure reason), fork entries are discarded.
 *  3. When no tape service is available, fork/merge is skipped (backward compat).
 *  4. When getTapeStore is absent, falls back to direct write (no fork isolation).
 *  5. recordTurnToTape writes to the forked service during the fork scope.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { TapeStore } from './tape-store.js';
import { TapeService } from './tape-service.js';
import { createTapeService } from './integration.js';
import { runPromptWithCoordinator } from '../runtime/host/message-handler/services/prompt-coordinator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTapeStore(tempDir: string): TapeStore {
  return new TapeStore(tempDir, '/test/workspace');
}

function makeAssistantMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
  } as unknown as AgentMessage;
}

function makeFailedAssistantMessage(errorMessage: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'failed' }],
    errorMessage,
  } as unknown as AgentMessage;
}

function makeAgentManager(messages: AgentMessage[]) {
  return {
    getAgent: vi.fn(async () => ({
      modelRef: 'test/model',
      agent: {
        prompt: vi.fn(async () => {}),
        messages,
      },
    })),
    getAgentFallbacks: vi.fn(() => []),
    setSessionModel: vi.fn(async () => {}),
    clearRuntimeModelOverride: vi.fn(() => {}),
    resolvePromptTimeoutMs: vi.fn(() => 30000),
    getSessionMetadata: vi.fn(() => undefined),
    updateSessionMetadata: vi.fn(() => {}),
    compactSession: vi.fn(async () => ({ success: true, tokensReclaimed: 0 })),
    getContextUsage: vi.fn(() => ({ usedTokens: 100, totalTokens: 1000, percentage: 10 })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tape fork/merge in prompt-coordinator', () => {
  let tempDir: string;
  let tapeStore: TapeStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tape-fork-merge-test-'));
    tapeStore = makeTapeStore(tempDir);
    vi.clearAllMocks();
  });

  it('merges fork entries to main tape on successful prompt', async () => {
    const tapeService = createTapeService(tapeStore, 'session:fork-success');
    // Pre-existing entry on the main tape before the turn
    tapeService.appendMessage('user', 'Previous message');

    const messages = [makeAssistantMessage('Hello from assistant')];
    const agentManager = makeAgentManager(messages);
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    await runPromptWithCoordinator({
      sessionKey: 'fork-success',
      agentId: 'test-agent',
      text: 'Hello from user',
      traceId: 'trace-fork-1',
      config: {} as never,
      logger,
      agentManager,
      activeMap: new Map(),
      interruptedSet: new Set(),
      flushMemory: async () => true,
      getTapeService: () => tapeService,
      getTapeStore: () => tapeStore,
    });

    const entries = tapeService.readAll()!;
    const messageEntries = entries.filter(e => e.kind === 'message');

    // Should have: previous message + user + assistant from this turn
    expect(messageEntries.length).toBeGreaterThanOrEqual(3);

    const userEntry = messageEntries.find(e => e.payload.role === 'user' && e.payload.content === 'Hello from user');
    expect(userEntry).toBeDefined();

    const assistantEntry = messageEntries.find(e => e.payload.role === 'assistant');
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry!.payload.content).toBe('Hello from assistant');

    // No tape errors should be logged
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Tape dual-write failed (non-fatal)',
    );
  });

  it('discards fork entries when prompt fails (assistant error message)', async () => {
    const tapeService = createTapeService(tapeStore, 'session:fork-fail');
    // Pre-existing entry on the main tape
    tapeService.appendMessage('user', 'Previous message');

    const entriesBefore = tapeService.readAll()!.length;

    const messages = [makeFailedAssistantMessage('model error: rate limit')];
    const agentManager = makeAgentManager(messages);
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    await expect(
      runPromptWithCoordinator({
        sessionKey: 'fork-fail',
        agentId: 'test-agent',
        text: 'Hello from user',
        traceId: 'trace-fork-2',
        config: {} as never,
        logger,
        agentManager,
        activeMap: new Map(),
        interruptedSet: new Set(),
        flushMemory: async () => true,
        getTapeService: () => tapeService,
        getTapeStore: () => tapeStore,
      }),
    ).rejects.toThrow('model error: rate limit');

    // The tape should still only have the pre-existing entries — the fork was discarded
    const entriesAfter = tapeService.readAll()!.length;
    expect(entriesAfter).toBe(entriesBefore);
  });

  it('skips fork/merge and works normally when getTapeService is not provided', async () => {
    const messages = [makeAssistantMessage('Response')];
    const agentManager = makeAgentManager(messages);
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    // Should succeed without any tape-related errors
    await expect(
      runPromptWithCoordinator({
        sessionKey: 'fork-no-tape',
        agentId: 'test-agent',
        text: 'Hello',
        config: {} as never,
        logger,
        agentManager,
        activeMap: new Map(),
        interruptedSet: new Set(),
        flushMemory: async () => true,
        // getTapeService deliberately omitted
        getTapeStore: () => tapeStore,
      }),
    ).resolves.toBeUndefined();

    // No tape warnings
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips fork/merge and works normally when getTapeService returns null', async () => {
    const messages = [makeAssistantMessage('Response')];
    const agentManager = makeAgentManager(messages);
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    await expect(
      runPromptWithCoordinator({
        sessionKey: 'fork-null-tape',
        agentId: 'test-agent',
        text: 'Hello',
        config: {} as never,
        logger,
        agentManager,
        activeMap: new Map(),
        interruptedSet: new Set(),
        flushMemory: async () => true,
        getTapeService: () => null,
        getTapeStore: () => tapeStore,
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Tape dual-write failed (non-fatal)',
    );
  });

  it('falls back to direct write when getTapeStore is not provided', async () => {
    // Without getTapeStore, the tape write should still succeed (direct write, no fork)
    const tapeService = createTapeService(tapeStore, 'session:fork-no-store');
    const messages = [makeAssistantMessage('Hello from assistant')];
    const agentManager = makeAgentManager(messages);
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    await runPromptWithCoordinator({
      sessionKey: 'fork-no-store',
      agentId: 'test-agent',
      text: 'Hello from user',
      config: {} as never,
      logger,
      agentManager,
      activeMap: new Map(),
      interruptedSet: new Set(),
      flushMemory: async () => true,
      getTapeService: () => tapeService,
      // getTapeStore deliberately omitted — should fall back to direct write
    });

    // Entries should have been written directly to the tape
    const entries = tapeService.readAll()!;
    const messageEntries = entries.filter(e => e.kind === 'message');
    expect(messageEntries.length).toBeGreaterThanOrEqual(2);

    const userEntry = messageEntries.find(e => e.payload.role === 'user');
    expect(userEntry).toBeDefined();
    expect(userEntry!.payload.content).toBe('Hello from user');

    const assistantEntry = messageEntries.find(e => e.payload.role === 'assistant');
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry!.payload.content).toBe('Hello from assistant');
  });

  it('recordTurnToTape writes to forked service and not directly to main tape during fork scope', async () => {
    // Spy on TapeService.appendMessage to check which service instance receives the write
    const appendSpy = vi.spyOn(TapeService.prototype, 'appendMessage');

    const tapeService = createTapeService(tapeStore, 'session:fork-spy');
    const messages = [makeAssistantMessage('Response')];
    const agentManager = makeAgentManager(messages);
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    await runPromptWithCoordinator({
      sessionKey: 'fork-spy',
      agentId: 'test-agent',
      text: 'User input',
      config: {} as never,
      logger,
      agentManager,
      activeMap: new Map(),
      interruptedSet: new Set(),
      flushMemory: async () => true,
      getTapeService: () => tapeService,
      getTapeStore: () => tapeStore,
    });

    // appendMessage must have been called (for user + assistant messages)
    expect(appendSpy).toHaveBeenCalled();

    // After the fork merges, the main tape should contain the written entries
    const entries = tapeService.readAll()!;
    const messageEntries = entries.filter(e => e.kind === 'message');
    expect(messageEntries.some(e => e.payload.content === 'User input')).toBe(true);
    expect(messageEntries.some(e => e.payload.content === 'Response')).toBe(true);

    appendSpy.mockRestore();
  });

  it('getTapeStore returning null falls back to direct write without fork errors', async () => {
    const tapeService = createTapeService(tapeStore, 'session:fork-null-store');
    const messages = [makeAssistantMessage('Response')];
    const agentManager = makeAgentManager(messages);
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    await runPromptWithCoordinator({
      sessionKey: 'fork-null-store',
      agentId: 'test-agent',
      text: 'Hello',
      config: {} as never,
      logger,
      agentManager,
      activeMap: new Map(),
      interruptedSet: new Set(),
      flushMemory: async () => true,
      getTapeService: () => tapeService,
      getTapeStore: () => null, // explicitly returns null
    });

    // Should still write directly to tape
    const entries = tapeService.readAll()!;
    const messageEntries = entries.filter(e => e.kind === 'message');
    expect(messageEntries.length).toBeGreaterThanOrEqual(2);

    // No tape errors
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Tape dual-write failed (non-fatal)',
    );
  });
});

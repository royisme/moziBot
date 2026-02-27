/**
 * TapeIntegration - Bridge layer between TapeService and moziBot runtime.
 *
 * This module provides factory functions and utilities for integrating the Tape system
 * into moziBot's existing runtime without modifying existing files. It serves as the
 * bridge layer that will be used in Phase 3/4 to replace existing session management.
 */

import { TapeStore } from './tape-store.js';
import { TapeService } from './tape-service.js';
import { selectMessages } from './tape-context.js';
import type { TapeMessage } from './tape-context.js';
import type { TapeInfo } from './types.js';

/**
 * Create a TapeStore for a workspace.
 * tapesDir defaults to {homePath}/tapes/
 */
export function createTapeStore(homePath: string, workspacePath: string): TapeStore {
  const tapesDir = `${homePath}/tapes`;
  return new TapeStore(tapesDir, workspacePath);
}

/**
 * Create a TapeService for a session.
 * tapeName format: {prefix}:{sessionSlug}
 */
export function createTapeService(
  store: TapeStore,
  tapeName: string,
): TapeService {
  const service = new TapeService(tapeName, store);
  service.ensureBootstrapAnchor();
  return service;
}

/**
 * Build LLM messages from tape (from last anchor).
 * This is the tape-based replacement for reading from session context[].
 */
export function buildMessagesFromTape(service: TapeService): TapeMessage[] {
  const entries = service.fromLastAnchor();
  return selectMessages(entries);
}

/**
 * Build LLM messages from all tape entries (ignoring anchors for windowing).
 */
export function buildAllMessages(service: TapeService): TapeMessage[] {
  const entries = service.readAll() ?? [];
  return selectMessages(entries);
}

/**
 * Record a user message + assistant response to the tape.
 * This is the dual-write bridge: call this alongside the existing session persistence.
 */
export function recordTurnToTape(
  service: TapeService,
  params: {
    userMessage: string;
    assistantMessage: string;
    toolCalls?: Record<string, unknown>[];
    toolResults?: unknown[];
    meta?: Record<string, unknown>;
  },
): void {
  service.appendMessage('user', params.userMessage, params.meta);

  if (params.toolCalls && params.toolCalls.length > 0) {
    service.appendToolCall(params.toolCalls, params.meta);
  }

  if (params.toolResults && params.toolResults.length > 0) {
    service.appendToolResult(params.toolResults, params.meta);
  }

  if (params.assistantMessage) {
    service.appendMessage('assistant', params.assistantMessage, params.meta);
  }
}

/**
 * Perform a tape-based "compaction" via handoff.
 * Instead of destructively dropping messages, creates an anchor with summary.
 * Returns the TapeInfo after handoff.
 */
export function compactViaTape(
  service: TapeService,
  summary: string,
  nextSteps?: string[],
): TapeInfo {
  service.handoff('auto-compact', {
    owner: 'system',
    summary,
    nextSteps,
  });
  return service.info();
}

/**
 * Execute a function within a forked tape context.
 * If the function throws, the fork is discarded.
 * If it succeeds, the fork is merged back.
 */
export async function withForkTape<T>(
  service: TapeService,
  store: TapeStore,
  fn: (forkedService: TapeService) => Promise<T>,
): Promise<T> {
  const { forkName, restore } = service.forkTape();
  const forkedService = new TapeService(forkName, store);

  try {
    const result = await fn(forkedService);
    service.mergeFork(forkName);
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

# Tape System Design

> Append-only event log as the single source of truth for agent session state.

## Motivation

moziBot currently manages session state through multiple overlapping mechanisms:

- `SessionStore` with JSONL transcript files (legacy + pi formats)
- In-memory `AgentMessage[]` arrays passed directly to LLM
- `compactMessages()` for context window management (destructive — drops history)
- Separate `memory/` module for long-term search

This creates fragmentation: the same data is represented differently across layers, compaction permanently destroys context, and there is no unified audit trail of agent activity.

The Tape system introduces a single append-only log that serves as the canonical record of all agent interactions, enabling non-destructive context management through anchors.

## Reference

This design is informed by the `bub` project's Tape implementation (`/Users/royzhu/software/myproject/test/bub/src/bub/tape/`), adapted for moziBot's TypeScript codebase and existing architecture.

## Core Concepts

### TapeEntry

The atomic unit of the tape. Every interaction — messages, tool calls, anchors, system events — is a TapeEntry.

```typescript
type TapeEntryKind =
  | "message" // LLM conversation message (user/assistant/system)
  | "tool_call" // Tool invocation
  | "tool_result" // Tool execution result
  | "anchor" // Phase boundary / handoff marker
  | "event" // System event (step.start, step.finish, etc.)
  | "system"; // Injected system instruction

interface TapeEntry {
  id: number; // Monotonically increasing within a tape
  kind: TapeEntryKind;
  payload: Record<string, unknown>;
  meta: Record<string, unknown>; // timestamps, model info, etc.
}
```

### Tape (file)

A single `.tape.jsonl` file. Append-only. Each line is a JSON-serialized `TapeEntry`.

Key properties:

- **Append-only**: entries are never modified or deleted in the active tape
- **Incremental reads**: tracks file offset to avoid re-reading on each access
- **Thread-safe**: serialized writes via async mutex
- **Archivable**: can be renamed to `.tape.jsonl.<timestamp>.bak`

### Anchor

A special `TapeEntry` with `kind: 'anchor'` that marks a phase boundary. Anchors enable non-destructive context windowing — instead of deleting old messages (compaction), we simply read from the last anchor forward.

```typescript
interface AnchorPayload {
  name: string; // e.g. "session/start", "phase-1", "task-complete"
  state?: {
    owner?: string; // "human" | "agent"
    summary?: string; // Summary of preceding context
    nextSteps?: string[]; // Carry-forward instructions
    [key: string]: unknown;
  };
}
```

### Handoff

Creating an anchor is called a "handoff". It signals a transition point:

- The LLM can trigger `tape.handoff` when context is getting long
- The system triggers it on session reset, segment rotation, or overflow compaction
- Each handoff carries optional summary/state that persists across the boundary

### Fork / Merge

For each user input cycle, a fork of the main tape is created:

```
Main Tape: [entry1, entry2, ..., entryN]
                                    |
                                    fork ──► Fork Tape: [entry1..N, new1, new2, ...]
                                    |
                                    merge ◄── only [new1, new2, ...] appended back
```

Benefits:

- Failed/aborted interactions don't pollute the main tape
- Concurrent inputs are isolated
- The main tape only receives committed results

### Context Reconstruction (Replay)

Instead of maintaining a mutable `messages[]` array, the tape is replayed to reconstruct LLM-compatible messages on demand:

```
Tape entries (from last anchor) → selectMessages() → AgentMessage[]
```

The `selectMessages()` function walks entries and builds the standard role-based message array that LLM APIs expect.

## Module Structure

```
src/tape/
├── types.ts          # TapeEntry, TapeEntryKind, AnchorPayload, TapeInfo
├── tape-file.ts      # Single .tape.jsonl file: read, append, archive
├── tape-store.ts     # Multi-tape manager: create, fork, merge, list, cleanup
├── tape-service.ts   # App-level operations: handoff, append, search, context queries
├── tape-context.ts   # Tape entries → AgentMessage[] conversion (replay)
└── index.ts          # Public API re-exports
```

### tape-file.ts

```typescript
class TapeFile {
  constructor(filePath: string);

  read(): TapeEntry[]; // Incremental read with offset tracking
  append(entry: TapeEntry): void; // Auto-assigns ID, appends to file
  appendMany(entries: TapeEntry[]): void;
  reset(): void; // Delete file, clear cache
  archive(): string | null; // Rename to timestamped .bak, return path
  copyTo(target: TapeFile): void; // Full copy for fork
  copyFrom(source: TapeFile, fromId: number): void; // Partial copy for merge
}
```

### tape-store.ts

```typescript
class TapeStore {
  constructor(tapesDir: string, workspacePath: string);

  list(): string[]; // All tape names for this workspace
  create(name: string): TapeFile; // Get or create a tape
  fork(sourceName: string): string; // Fork → returns new tape name
  merge(sourceName: string, targetName: string): void; // Merge fork back
  reset(name: string): void;
  archive(name: string): string | null;
  read(name: string): TapeEntry[] | null;
  append(name: string, entry: TapeEntry): void;
}
```

File naming: `{workspaceHash}__{urlEncodedTapeName}.tape.jsonl`

### tape-service.ts

```typescript
class TapeService {
  constructor(tapeName: string, store: TapeStore);

  // Core operations
  appendMessage(role: string, content: string, meta?: Record<string, unknown>): void;
  appendToolCall(calls: ToolCallPayload[]): void;
  appendToolResult(results: ToolResultPayload[]): void;
  appendEvent(name: string, data: Record<string, unknown>): void;
  appendSystem(content: string): void;

  // Anchor / Handoff
  handoff(name: string, state?: AnchorPayload["state"]): void;
  ensureBootstrapAnchor(): void;

  // Fork
  forkTape(): { tapeName: string; restore: () => void };
  mergeFork(forkName: string): void;

  // Queries
  info(): TapeInfo;
  anchors(limit?: number): AnchorSummary[];
  fromLastAnchor(kinds?: TapeEntryKind[]): TapeEntry[];
  betweenAnchors(start: string, end: string, kinds?: TapeEntryKind[]): TapeEntry[];
  afterAnchor(anchor: string, kinds?: TapeEntryKind[]): TapeEntry[];
  search(query: string, limit?: number): TapeEntry[];

  // Context reconstruction
  selectMessages(opts?: { fromLastAnchor?: boolean }): AgentMessage[];
}
```

### tape-context.ts

Stateless functions that convert `TapeEntry[]` into `AgentMessage[]`:

```typescript
function selectMessages(entries: TapeEntry[]): AgentMessage[];
// Walks entries, builds:
//   kind=message     → { role, content }
//   kind=tool_call   → { role: 'assistant', tool_calls: [...] }
//   kind=tool_result → { role: 'tool', content, tool_call_id }
//   kind=anchor      → (skipped, used for windowing)
//   kind=event       → (skipped, internal bookkeeping)
//   kind=system      → { role: 'system', content }
```

## Integration Plan

### Phase 1: Foundation (P0)

Create `src/tape/` with types, tape-file, and tape-store. Pure library code, no integration points yet. Fully unit-tested.

Files: `types.ts`, `tape-file.ts`, `tape-store.ts`, `index.ts`

### Phase 2: Service Layer (P1)

Add `tape-service.ts` and `tape-context.ts`. Wire dual-write into `SessionStore.update()` so that every session write also appends to the tape.

Integration point in `prompt-coordinator.ts`:

```typescript
// After prompt completes, also append to tape
tapeService.appendMessage("user", text);
tapeService.appendMessage("assistant", responseText);
```

### Phase 3: Anchor-based Context (P2)

Replace `compactMessages()` as the primary context management strategy:

Before (destructive):

```
[msg1..msg500] → compact → [summary, msg480..msg500]
```

After (non-destructive):

```
[msg1..msg200] → handoff("phase-1", {summary}) → [msg201..msg500]
Tape still has everything. LLM sees only post-anchor entries.
```

Modify `prompt-coordinator.ts` to use `tapeService.selectMessages({ fromLastAnchor: true })` instead of `agent.messages`.

### Phase 4: Fork/Merge for Input Isolation (P3)

Wrap each user input cycle in a fork:

```typescript
// In message handler orchestrator
const fork = tapeService.forkTape();
try {
  const result = await handleInput(text);
  tapeService.mergeFork(fork.tapeName);
  return result;
} catch (err) {
  fork.restore(); // discard failed interaction
  throw err;
}
```

### Phase 5: Migration Complete (P4)

- Remove legacy transcript writing from `SessionStore`
- Tape becomes the sole persistence layer
- `SessionStore` becomes a thin metadata index over tapes

## Mapping to Existing moziBot Components

| moziBot Component                | Tape Equivalent                  | Migration Path                       |
| -------------------------------- | -------------------------------- | ------------------------------------ |
| `SessionStore.writeTranscript()` | `TapeFile.append()`              | Dual-write → replace                 |
| `SessionState.context[]`         | `tapeService.selectMessages()`   | Read from tape instead               |
| `rotateSegment()`                | `tapeService.handoff()`          | Map segment rotation to anchor       |
| `compactMessages()`              | `fromLastAnchor()`               | Anchor windowing replaces truncation |
| `memory/flush-manager`           | `tapeService.search()` + entries | Extract from tape for indexing       |
| `context-window-guard`           | Anchor-triggered by token count  | handoff when approaching limit       |

## Testing Strategy

- Unit tests for `TapeFile`: read/write/append/archive/incremental-offset
- Unit tests for `TapeStore`: fork/merge/list/cleanup
- Unit tests for `tape-context.ts`: entry→message conversion
- Integration test: full cycle — append entries, handoff, fork, merge, verify context reconstruction
- Property tests: fork+merge preserves all entries, IDs are monotonic

## Open Questions

1. Should the tape also capture streaming chunks, or only final messages?
   → Recommendation: only final messages. Streaming is a delivery concern, not a state concern.

2. How to handle multi-agent (subagent) scenarios?
   → Each subagent gets its own tape. The parent tape records a `tool_call`/`tool_result` pair that references the subagent's tape name.

3. Memory indexing — should `memory/` read from tape directly?
   → Phase 2+: yes, the memory flush pipeline should extract from tape entries rather than from `AgentMessage[]`.

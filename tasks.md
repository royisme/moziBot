# Pi Session Alignment (Mozi) - Task Tracker

## Scope

Align Mozi session persistence with pi SessionManager while keeping Mozi session paths and file naming. No migration of existing sessions.

## Decisions

- Use pi SessionManager as the session transcript writer (JSONL tree structure).
- Keep Mozi session paths (no ~/.pi or OpenClaw paths).
- Keep file naming as `<sessionId>.jsonl`.
- Keep SessionStore as the mapping layer (sessionKey -> sessionFile/metadata).
- No migration for existing sessions; only new sessions use pi SessionManager.

## Plan (High Level)

1. Session storage alignment
2. Transcript writing via SessionManager
3. Memory indexing path + event wiring
4. Command and lifecycle updates
5. Tests + validation
6. Docs update (required for L2)

## Tasks

- [ ] Audit Mozi SessionStore and transcript flow; map all write/read entry points
- [ ] Design sessionFile resolution using Mozi paths + pi SessionManager open()
- [x] Implement session transcript writer using SessionManager (new sessions only)
- [x] Wire transcript update events for memory indexing
- [x] Verify memory session file readers/exporters handle pi JSONL tree format
- [x] Adjust compaction/reset flows for pi session entries
- [x] Add/adjust tests for session persistence and memory sync
- [x] Add docs update (architecture/ADR) describing new session storage
- [x] Run validation commands

## Progress Log

- 2026-02-26: Created task tracker and aligned decisions.
- 2026-02-26: Added pi session format metadata, transcript update events, docs updates, tests, and pi reset semantics.

## Risks / Open Questions

- How to represent sessionKey -> sessionFile mapping without breaking existing SessionStore usage
- Ensuring backward compatibility when old transcripts are read alongside new pi-style transcripts
- Memory index performance impact when compaction entries grow

---

# Embedded Memory Backend (OpenClaw-style) - Task Tracker

## Scope

Add an embedded memory backend that uses embeddings + vector/FTS hybrid search, aligned with OpenClaw architecture while keeping Mozi config style and paths. Default backend remains `builtin`.

## Decisions

- Use `memory.backend = "embedded"` to enable the new backend.
- Support OpenAI-compatible embedding endpoints with built-in defaults for `openai` and `ollama`.
- Keep Mozi paths (no `.pi`/OpenClaw paths).
- Optional session transcript indexing via `sources: ["memory", "sessions"]` (default: memory only).
- Builtin remains the fallback backend if embedded fails.

## Plan (High Level)

1. Add embedded config schema + resolver
2. Implement embedded manager (indexing, embeddings, hybrid search)
3. Wire embedded backend into memory factory and lifecycle orchestration
4. Update docs + ADR
5. Add/adjust tests and validation

## Tasks

- [x] Extend memory config schema to include `embedded` settings
- [x] Resolve embedded config (defaults, paths, provider)
- [x] Implement embedded memory manager (schema, indexing, search)
- [x] Implement embedding provider (OpenAI-compatible + Ollama defaults)
- [x] Add session transcript indexing (optional)
- [x] Wire into `getMemoryManager()` with fallback to builtin
- [x] Update docs and add ADR
- [x] Add tests for config and embedded manager basics
- [x] Run validation commands

## Progress Log

- 2026-02-26: Created embedded memory task tracker and decisions.
- 2026-02-26: Implemented embedded backend, docs, tests, and schema updates.

## Risks / Open Questions

- Vector extension availability in all target environments (sqlite-vec load)
- Provider latency/failure handling for embedding calls
- Session indexing performance on large transcripts

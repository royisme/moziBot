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

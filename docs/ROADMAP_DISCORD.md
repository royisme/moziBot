# Discord Roadmap

This document tracks Discord channel parity work for Mozi (adapter-based, not a full subsystem).

## Implemented (2026-02-26)

- Outbound chunking at 2000 characters (paragraph-first)
- `silent` flag mapped to suppress notifications
- `replyToId` applied only to the first chunk
- Attachments via `buffer` and `path` (URLs remain as text links)
- Status reactions (existing)

## Planned (Roadmap)

- Markdown-aware chunking
- Components / buttons
- Polls
- Webhook sends
- Voice message send
- Media upload from URL (download + size guardrails)
- Forum/media channel thread auto-creation
- Permission diagnostics + error detail expansion
- Guild/Channel/Member management utilities
- Search/read history + pin/unpin

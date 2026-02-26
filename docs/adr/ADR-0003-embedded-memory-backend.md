---
Date: 2026-02-26
Status: Accepted
---

# ADR-0003: Embedded Memory Backend (OpenClaw-style)

## Context

Mozi currently supports `builtin` (FTS) and `qmd` (CLI) memory backends. QMD cannot use external embedding providers, and Mozi lacks an embedded vector search backend that can integrate with OpenAI-compatible embedding endpoints (including local Ollama). We need a safer, more controllable approach aligned with OpenClaw’s memory search architecture while keeping Mozi’s configuration style and paths.

## Decision

Add a new `memory.backend = "embedded"` option that provides:

- Local SQLite storage for chunked memory documents.
- Embedding generation via OpenAI-compatible `/embeddings` endpoints (defaults for OpenAI and Ollama).
- Optional sqlite-vec vector table and hybrid vector + FTS search.
- Optional session transcript indexing via `sources: ["memory", "sessions"]`.
- Builtin backend remains the fallback when embedded fails.

Configuration is introduced under `memory.embedded` and follows Mozi’s existing configuration style (no OpenClaw path conventions).

## Alternatives Considered

1. **Continue with QMD only**  
   Rejected because QMD cannot use external embedding providers, and does not meet the requirement for local embedding options.

2. **Directly adopt OpenClaw config & paths**  
   Rejected to preserve Mozi’s existing config style and path layout.

## Consequences / Tradeoffs

- Adds complexity in memory indexing, embedding requests, and vector storage.
- Requires sqlite-vec availability for best vector performance; falls back to cosine similarity without it.
- Introduces additional configuration surface area for embedding providers and hybrid search.

## Validation

- Unit tests for embedded manager indexing and search.
- Config resolution tests for embedded defaults.
- Standard `pnpm run test`.

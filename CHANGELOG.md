# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- N/A

## [2.0.1] - 2026-03-11

### Changes

- No changes recorded.

### Fixes

- N/A


## [2.0.0] - 2026-03-10

### Changes

- add ignore (17499c6)
- feat: expose subagent run status and inspection (14d8b65)
- add ignore (8b89cf1)
- test: add unit tests for runtime channel capabilities delegation (568a1db)
- fix: use real channel plugin for capability context (c1f4cd3)
- fix: use real channel plugin for capability context (fc67427)
- docs: add ACP detached runtime upgrade spec (95d5cfa)
- feat: generalize subagent to neutral detached-run abstraction (Phase 3) (69a619f)
- feat: add channel-aware action dispatch pipeline (7ef500c)
- feat: integrate real ACPX runtime lifecycle (e38c3e2)
- fix ACPX bootstrap follow-ups (31ecec8)
- docs: document doctor commands and validation hooks (f23078e)

### Fixes

- N/A

## [1.3.0] - 2026-02-26

### Changes

- feat: improve skills and channel adapters (70f6308)
- feat: add browser waitfor and auto tab (c7b2643)
- feat: add browser target resilience (07db9f7)
- feat: add basic browser actions (071f569)
- feat: deliver task1 updates (da43a79)
- fix(prompt): stabilize reset greeting and add digest (2b40e4a)
- feat: enhance heartbeat context (a109008)
- feat: align runtime defaults and routing (aadc962)
- feat(memory): add low-recall fallback (4f9c574)
- feat(memory): add qmd searchMode fan-out (3ebdc4d)
- feat(runtime): expand hook coverage for messaging and compaction (d76fd5a)
- fix(runtime): store model registry config (f431a20)
- feat(runtime): load external hooks from config (9e87d80)
- feat(discord): add access control policies (58bafd0)
- feat(memory): add preflush threshold and cooldown (1a3aae5)
- feat(runtime): add cli backends for local codex/claude (6d58583)
- feat(runtime): unify lifecycle and session reset (eff351e)

### Fixes

- fix(desktop-widget): repair client event listener typing for build

## [1.2.0] - 2026-02-18

### Added

- **Extensions Framework**: Plugin-style commands hooks and external module loading
- **OpenClaw Migration**: Memory recall migration case support
- **Contract v2**: Lifecycle convergence and builtin compatibility
- **Hook Framework**: Memory maintainer with prompt safety hardening
- **Identity Protection**: Drift protection for persona enforcement
- **Prompt Metadata**: Tracking and logging in AgentManager
- **Prompt Modes**: Support for main/reset-greeting/subagent-minimal modes
- **Subagent Config**: promptMode configuration with defaults and per-agent override
- **Streaming**: Reply finalization for message handling

### Changed

- Enhanced `/new` greeting with persona and language enforcement
- Added prompt metadata to `/status` and reset greeting support
- Consolidated message-handler flow around turn runtime
- Unified prompt composition and removed legacy host agent loaders
- Removed regex-based identity guards and negative-prompt constraints

### Fixed

- Aligned `/new` greeting language with identity
- Aligned schema docs and hardened runtime config flow
- Hardened terminal reply resolution and reasoning redaction

### Internal

- Added shared harness and hardened new-session language parsing

## [1.1.1] - 2026-02-15

### Added

- **Desktop Widget**: Full-featured floating desktop widget with Live2D avatar support
  - Live2D Cubism 4 model rendering with lip-sync for TTS
  - Alternative Orb renderer (Three.js) for lightweight environments
  - Audio capture for voice input and playback for TTS output
  - Real-time WebSocket audio streaming
  - Automatic environment detection (auto/on/off widget mode)
  - WebGL context loss/recovery handling
- **Widget Configuration**: `channels.localDesktop.widget.mode` with auto/on/off semantics
  - Defaults to "auto" - automatically detects desktop environment
  - Environment variable overrides: `MOZI_WIDGET_MODE`, `MOZI_WIDGET_HEADLING`
  - Runtime config endpoint for widget settings
- **Audio Services**: Web Audio API integration with ScriptProcessorNode (AudioWorklet ready)

### Changed

- Improved local desktop channel with widget mode detection and graceful degradation
- Enhanced traceability with traceId propagation throughout message pipeline
- Safer reasoning output defaults (hidden unless explicitly enabled)
- Refactored config schema to support widget configuration

## [1.0.2] - 2026-02-10

### Added

- Added a dedicated `docs/GETTING_STARTED.md` guide with minimal required setup (config, env, first run checks).
- Added project logo asset at `docs/assets/logo.png` and wired it into README.

### Changed

- Clarified project positioning in README (small, focused, daily-use, non-goals).
- Added memory lifecycle orchestration with session-start/search/flush event handling and coalesced sync behavior.
- Added QMD memory reliability controls (retry/backoff, circuit-breaker, fallback preemption) and corresponding docs/schema updates.

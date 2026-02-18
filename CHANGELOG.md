# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- N/A

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

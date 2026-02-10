# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- N/A

## [1.0.2] - 2026-02-10

### Added

- Added a dedicated `docs/GETTING_STARTED.md` guide with minimal required setup (config, env, first run checks).
- Added project logo asset at `docs/assets/logo.png` and wired it into README.

### Changed

- Clarified project positioning in README (small, focused, daily-use, non-goals).
- Added memory lifecycle orchestration with session-start/search/flush event handling and coalesced sync behavior.
- Added QMD memory reliability controls (retry/backoff, circuit-breaker, fallback preemption) and corresponding docs/schema updates.

---
title: "Browser Relay Tasks"
summary: "Implementation tasks for Chrome Extension Relay + Local CDP"
---

# Browser Relay Tasks

## Phase 0 - Alignment

- [ ] Confirm final config schema names and defaults.
- [ ] Decide relay auth header name (e.g., `x-mozibot-relay-token`).
- [ ] Confirm default relay port and profile naming.

## Phase 1 - Config & Validation

- [ ] Extend config schema to include `browser` section with profiles.
- [ ] Add validation for:
  - `driver=extension` must use loopback `cdpUrl`.
  - `driver=cdp` allows loopback only (initially).
  - `browser.relay.authToken` required when relay enabled.
- [ ] Add config docs update to explain browser modes.

## Phase 2 - Relay Server

- [ ] Implement relay server:
  - [ ] HTTP routes: `/json/version`, `/json/list`, `/extension/status`.
  - [ ] WebSocket routes: `/extension`, `/cdp`.
  - [ ] Loopback-only binding.
  - [ ] Token enforcement for `/json/*` + `/cdp`.
  - [ ] Origin validation for extension WS.
- [ ] Derive relay token from relay auth token + port (HMAC).
- [ ] Detect and reuse existing relay on port (probe `/json/version`).

## Phase 3 - Browser Client Integration

- [ ] Add relay auth header injection when connecting to relay CDP.
- [ ] Ensure browser tool picks `browser.defaultProfile`.
- [ ] Add error messaging when relay is up but no extension tab attached.

## Phase 4 - Skill (Setup Wizard)

- [ ] Create `browser-setup` skill:
  - [ ] Read config, prompt for mode.
  - [ ] Validate relay auth token presence.
  - [ ] Write config updates to `~/.mozi/config.jsonc`.
  - [ ] Run health checks and return instructions.
- [ ] Provide guidance for installing the Chrome extension.

## Phase 5 - Tests

- [ ] Unit tests for relay token derivation.
- [ ] Relay server auth + loopback enforcement tests.
- [ ] Integration test for `/json/version` with auth header.
- [ ] Manual checklist for extension attach + tab control.

## Phase 6 - Docs

- [ ] Update `docs/GETTING_STARTED.md` with browser setup steps.
- [ ] Add troubleshooting section (common errors + fixes).

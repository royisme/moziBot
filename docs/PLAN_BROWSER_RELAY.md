---
title: "Browser Relay Plan"
summary: "Design for Chrome Extension Relay + Local CDP in Mozi"
---

# Browser Relay Plan

## Goals

- Provide a reliable, configurable browser control capability in Mozi.
- Support two modes:
  - Chrome Extension Relay (takeover of an existing Chrome tab).
  - Local CDP (connect to a locally launched Chrome with remote debugging).
- Enable guided setup via a skill while keeping config as the source of truth.
- Maintain strict security boundaries (loopback-only, token-authenticated relay).

## Non-Goals

- Remote CDP over public network.
- Multi-tenant isolation or per-user auth beyond relay auth token.
- Cross-platform extension packaging (initially: macOS/Windows manual install).

## User Experience Summary

1. User runs a setup skill (e.g., `browser-setup`).
2. Skill checks prerequisites, writes config, and validates connectivity.
3. Agent can invoke browser tools; if using extension relay, user is prompted to attach the tab.

## Architecture Overview

### Components

1. **Relay Server (host-side)**
   - Exposes:
     - `GET /json/version`
     - `GET /json/list`
     - `WS /cdp`
     - `WS /extension` (Chrome extension connects here)
   - Enforces:
     - Loopback-only binding (127.0.0.1 / ::1).
     - Auth token required for `/json/*` and `/cdp` access.
     - Origin check for extension WS (`chrome-extension://`).

2. **Extension Bridge**
   - Chrome extension connects to relay via `ws://127.0.0.1:<port>/extension?token=...`
   - Forwards CDP commands + events between Chrome and relay.

3. **Browser Client**
   - Uses CDP endpoints from relay or local Chrome.
   - Uses relay auth headers when connecting to relay endpoints.

4. **Skill**
   - Performs guided setup and validation.
   - Writes config to `~/.mozi/config.jsonc` (single source of truth).

## Config Schema (Proposed)

```jsonc
{
  "browser": {
    "enabled": true,
    "profiles": {
      "chrome": {
        "driver": "extension",
        "cdpUrl": "http://127.0.0.1:9222",
      },
      "local": {
        "driver": "cdp",
        "cdpUrl": "http://127.0.0.1:9223",
      },
    },
    "defaultProfile": "chrome",
    "relay": {
      "enabled": true,
      "bindHost": "127.0.0.1",
      "port": 9222,
      "authToken": "REPLACE_WITH_REAL_TOKEN",
    },
  },
}
```

### Notes

- Relay token is derived from `browser.relay.authToken` + port using HMAC.
- `browser.defaultProfile` selects which profile the browser tool uses by default.

## Behavior Details

### Relay Startup

- Relay server starts if:
  - `browser.relay.enabled=true`
  - The active profile `driver=extension`
- Relay binds to loopback only.
- If port is occupied:
  - If occupied by an existing Mozi relay, reuse it.
  - Otherwise fail with a clear error.

### Extension Connection

- Extension connects to `/extension` with `x-mozibot-relay-token` header or `?token=...`.
- If no extension tab is attached, the browser tool reports a clear, user-friendly message:
  - "Relay is running but no tab is attached. Click the browser extension icon to attach."

### Local CDP

- Uses direct CDP connection to configured `cdpUrl`.
- No relay token required.

## Security Model

- Loopback-only binding and strict origin checks.
- Relay token derived from relay auth token.
- No public exposure, no HTTP bind to 0.0.0.0.
- Deny remote or non-loopback CDP URLs for extension relay.

## Telemetry & Observability

- Log relay startup/shutdown and extension connection events.
- Provide a `/browser_status` command (optional) for debugging.

## Skill Workflow (High-Level)

1. Detect config file + load existing browser settings.
2. Prompt for desired mode (extension relay vs local CDP).
3. Validate `browser.relay.authToken` presence.
4. Write config changes to `~/.mozi/config.jsonc`.
5. Run health checks:
   - Relay HTTP check (`/json/version`) with token.
   - If extension mode: confirm extension WS is connected.
6. Return actionable status message and next steps.

## Acceptance Criteria

- Relay can be enabled solely by config + skill setup.
- Browser tool can list tabs via relay when extension is attached.
- Errors are clear when extension is not attached.
- No relay access from non-loopback hosts.

## Test Plan

### Unit

- Relay token derivation logic (HMAC).
- Relay auth header injection for known relay ports.
- Config schema validation for profiles.

### Integration

- Relay starts/stops correctly on loopback.
- `/json/version` returns expected payload with auth token.
- WebSocket connection to `/cdp` rejected without token.

### Manual

- Extension attach flow succeeds.
- Tabs list + screenshot works from an attached tab.

## Rollback Plan

- Disable `browser.relay.enabled` and switch `browser.defaultProfile` to `local`.
- Remove extension profile from config.

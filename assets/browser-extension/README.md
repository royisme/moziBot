# Mozi Browser Relay Extension

Purpose: attach Mozi to an existing Chrome tab so the runtime can automate it (via the local CDP relay server).

## Dev / load unpacked

1. Run the Mozi runtime with browser relay enabled.
2. Ensure the relay server is reachable at `http://127.0.0.1:9222/` (default).
3. Chrome → `chrome://extensions` → enable “Developer mode”.
4. “Load unpacked” → select `assets/browser-extension`.
5. Pin the extension. Click the icon on a tab to attach/detach.

## Options

- `Relay port`: defaults to `9222`.
- `Relay auth token`: required. Set this to `browser.relay.authToken` in `~/.mozi/config.jsonc`.

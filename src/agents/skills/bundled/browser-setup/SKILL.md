---
name: browser-setup
description: Guided setup for browser relay (extension) or local CDP profiles.
---

# Browser Setup

Use this skill to guide users through enabling the browser relay or local CDP.

## Steps

1. Detect current config

- Read `~/.mozi/config.jsonc` (or `MOZI_CONFIG` if set).
- Check `browser` + `browser.relay.authToken` fields.

2. Choose mode

- Extension relay (existing Chrome tabs): `driver = "extension"`.
- Local CDP (remote debugging): `driver = "cdp"`.

3. Ensure relay auth token

- `browser.relay.authToken` is required when `browser.relay.enabled=true`.
- Use a strong random token; never paste real tokens into docs/tests.

4. Write/patch config

- Add `browser.profiles` with `cdpUrl` using loopback host + explicit port (required for `driver:"cdp"`, optional for `driver:"extension"` when relay is enabled).
- Set `browser.defaultProfile`.
- Set `browser.relay.enabled=true` for extension profiles (extension profiles may omit `cdpUrl` when relay port is configured).

5. Validate connectivity

- Relay health: `GET /json/version` with `x-mozibot-relay-token` header.
- Extension status: `GET /extension/status`.

6. Extension install (for relay mode)

- Chrome → `chrome://extensions` → enable Developer mode.
- Load unpacked: `assets/browser-extension`.
- Open extension Options and set relay port + relay auth token.
- Click the extension icon on a tab to attach.

## Expected Errors

- Missing relay auth token: relay startup fails with a clear message.
- Extension not attached: tabs list returns a prompt to attach.

## Done

- `browser` tool can list tabs for the selected profile.

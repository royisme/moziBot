# Mozi Desktop Widget (Vite + Tauri)

mac-first floating widget that connects to Mozi localDesktop channel.

## Prerequisites

- Mozi runtime started with `channels.localDesktop.enabled=true`
- Rust toolchain + Tauri prerequisites installed
- `pnpm` available

## Run (dev)

```bash
cd desktop-widget
pnpm install
pnpm tauri:dev
```

This starts Vite (`127.0.0.1:1420`) and opens the transparent always-on-top Tauri window.

## Build web assets only (safe default)

```bash
cd desktop-widget
pnpm install
pnpm build
```

## Build desktop app (native package)

```bash
cd desktop-widget
pnpm install
pnpm build:native
```

## Runtime channel expectation

Widget expects local channel endpoints:

- `POST http://127.0.0.1:3987/inbound`
- `GET  http://127.0.0.1:3987/events?peerId=desktop-default`

## Widget config source (single source of truth)

Widget no longer keeps a separate config file. It reads config from Mozi runtime endpoint:

- `GET http://127.0.0.1:3987/widget-config`

Runtime returns effective localDesktop settings (including defaults). Rules:

- `enabled` is the widget on/off switch.
- `host`/`port` come from runtime effective config, defaulting to `127.0.0.1:3987`.
- Host is local-only by design.
- `authToken` is optional. If set, widget sends bearer token for `/inbound` and query token for `/events`.

Env overrides (optional):

- `VITE_WIDGET_ENABLED`
- `VITE_WIDGET_HOST`
- `VITE_WIDGET_PORT`
- `VITE_WIDGET_TOKEN`
- `VITE_WIDGET_PEER_ID`

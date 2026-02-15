# Mozi Desktop Widget (Vite + Tauri)

mac-first floating widget that connects to Mozi localDesktop channel.

## Prerequisites

- Mozi runtime started with `channels.localDesktop.widget.mode` set to `auto` (default) or `on`
- Rust toolchain + Tauri prerequisites installed
- `pnpm` available

## Setup

```bash
cd desktop-widget
pnpm install
pnpm run setup:models   # downloads Live2D sample models (Hiyori, Mark)
```

## Run (dev)

```bash
pnpm dev                # web-only at 127.0.0.1:1420
pnpm tauri:dev          # Tauri window (transparent, always-on-top)
```

## Build web assets only (safe default)

```bash
pnpm build
```

## Build desktop app (native package)

```bash
pnpm build:native
```

## Avatar modes

| Mode               | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| `live2d` (default) | Live2D Cubism 4 model with lip-sync. Falls back to `orb` on load failure. |
| `orb`              | Three.js animated orb.                                                    |

Configure via env or runtime config:

| Env var                  | Description            | Default                             |
| ------------------------ | ---------------------- | ----------------------------------- |
| `VITE_AVATAR_MODE`       | `live2d` or `orb`      | `live2d`                            |
| `VITE_AVATAR_MODEL_PATH` | Path to `.model3.json` | `/models/Hiyori/Hiyori.model3.json` |
| `VITE_AVATAR_SCALE`      | Model scale (0.01–10)  | auto-computed                       |

## Runtime channel expectation

Widget expects local channel endpoints:

- `POST http://127.0.0.1:3987/inbound`
- `GET  http://127.0.0.1:3987/events?peerId=desktop-default`
- `WS   ws://127.0.0.1:3987/audio?peerId=desktop-default`

## Widget config source (single source of truth)

Widget reads config from Mozi runtime endpoint:

- `GET http://127.0.0.1:3987/widget-config`

Runtime returns effective localDesktop settings (including defaults). Rules:

- `widget.mode`: `auto` (show when runtime active), `on` (always), `off` (disabled).
- `host`/`port` come from runtime effective config, defaulting to `127.0.0.1:3987`.
- Host is local-only by design.
- `authToken` is optional. If set, widget sends bearer token for `/inbound` and query token for `/events`.

Env overrides (optional):

- `VITE_WIDGET_ENABLED`
- `VITE_WIDGET_HOST`
- `VITE_WIDGET_PORT`
- `VITE_WIDGET_TOKEN`
- `VITE_WIDGET_PEER_ID`

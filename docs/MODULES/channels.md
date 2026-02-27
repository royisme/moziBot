# Channels Module (`src/runtime/adapters/channels/`)

## Purpose

Channel adapters bridge external messaging transports into Mozi's normalized `InboundMessage` / `OutboundMessage` contracts.

Contract files:

- `src/runtime/adapters/channels/types.ts`
- `src/runtime/adapters/channels/plugin.ts`
- `src/runtime/adapters/channels/registry.ts`

Implementations:

- `telegram/plugin.ts`
- `discord/plugin.ts`
- `local-desktop/plugin.ts`

## Telegram Native Commands

Telegram registers native bot commands via `setMyCommands` in `telegram/plugin.ts`.
Current built-in command menu includes:

- `/help`
- `/status`
- `/whoami`
- `/context`
- `/prompt_digest`
- `/models`
- `/skills` (with `/skill` alias in text-command parser)
- `/switch`
- `/new`
- `/reset`
- `/compact`
- `/restart`

## Local Desktop Widget

The local desktop channel exposes a lightweight widget endpoint used by the desktop UI.

Startup control:

- `channels.localDesktop.widget.mode`: `auto | on | off` (drives whether the widget server should start)
- `MOZI_WIDGET_MODE` env var can override startup behavior

UI configuration (served via `GET /widget-config`):

```jsonc
{
  "channels": {
    "localDesktop": {
      "widget": {
        "uiMode": "voice",
        "voiceInputMode": "ptt",
        "voiceOutputEnabled": true,
        "textOutputEnabled": true,
      },
    },
  },
}
```

Fields:

- `uiMode`: `voice | text` (default: `voice`)
- `voiceInputMode`: `ptt | vad` (default: `ptt`)
- `voiceOutputEnabled`: boolean (default: `true`)
- `textOutputEnabled`: boolean (default: `true`)

Notes:

- `widget.mode` controls startup only; it is separate from `widget.uiMode`.
- The widget can also override values via `VITE_WIDGET_*` env vars on the frontend.

## Channel Contract

All channel plugins must implement `ChannelPlugin`:

- lifecycle: `connect()`, `disconnect()`
- messaging: `send()` (+ optional `editMessage`, `beginTyping`, `emitPhase`, `setStatusReaction`)
- status and event emission through `EventEmitter`

`InboundMessage` carries normalized sender/peer/media fields used by runtime host and multimodal ingest.

## Status Reactions

Channels can optionally surface lifecycle status (queued/thinking/tool/done/error) as message reactions
via `setStatusReaction`. Telegram/Discord enable this via config:

```jsonc
{
  "channels": {
    "telegram": {
      "statusReactions": {
        "enabled": true,
        "emojis": {
          "queued": "👀",
          "thinking": "🤔",
          "tool": "🔥",
          "done": "👍",
          "error": "😱",
        },
      },
    },
    "discord": {
      "statusReactions": {
        "enabled": true,
        "emojis": {
          "queued": "👀",
          "thinking": "🤔",
          "tool": "🔥",
          "done": "👍",
          "error": "😱",
        },
      },
    },
  },
}
```

Defaults are disabled and fall back to the emojis above when enabled.

## Discord Role Access + Routing

Discord guilds can optionally enforce role allowlists and route to agents by role:

```jsonc
{
  "channels": {
    "discord": {
      "guilds": {
        "guild-id": {
          "allowRoles": ["role-id-1", "role-id-2"],
          "roleRouting": {
            "role-id-1": { "agentId": "dev-pm" },
            "role-id-2": { "agentId": "dev-arch" },
          },
        },
      },
    },
  },
}
```

When `allowRoles` is set, members must have a matching role even if user allowlists pass.

## Runtime Integration

`RuntimeHost.initializeChannels()` registers and connects plugins, then forwards message events into kernel enqueue.

If changing channel payload semantics, also inspect:

- `src/runtime/host/message-handler.ts`
- `src/multimodal/ingest.ts`
- `src/multimodal/outbound.ts`

## Where to Edit

### Add a new channel adapter

1. Create `src/runtime/adapters/channels/<name>/plugin.ts`
2. Implement `ChannelPlugin`
3. Register/wire in `RuntimeHost.initializeChannels()`
4. Add config schema entry in `src/config/schema/channels.ts`
5. Add tests

### Change message normalization fields

- Edit `types.ts` and adapter mapper code
- Also update `message-handler.ts`, multimodal ingest, and tests

## Verification

- `pnpm run test`
- Focus tests:
  - `src/runtime/adapters/channels/telegram/*.test.ts`
  - `src/runtime/adapters/channels/discord/*.test.ts`
  - `src/runtime/adapters/channels/local-desktop/*.test.ts`
  - `src/runtime/adapters/channels/registry.test.ts`

## Constraints

- Keep `InboundMessage` compatible with host/router/session-key expectations.
- For streaming/edit semantics, preserve graceful fallback when a channel does not support edits.

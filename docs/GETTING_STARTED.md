# Getting Started (Required Setup)

This guide is the **minimum required setup** to run Mozi locally.

If you skip this section, the runtime will start but cannot answer because model credentials/config are missing.

## 1) Prerequisites

- Node.js `>= 22.12.0`
- `pnpm`
- (Optional) Docker, only if sandbox execution is enabled

## 2) Install

```bash
git clone https://github.com/royzhu/mozi.git
cd mozi
pnpm install
```

## 3) Create runtime config

Create `~/.mozi/config.jsonc`:

```jsonc
{
  "paths": {
    "baseDir": "~/.mozi",
  },
  "models": {
    "providers": {
      "openai": {
        "api": "openai-responses",
        "apiKey": "${OPENAI_API_KEY}",
        "models": [{ "id": "gpt-4o-mini" }],
      },
    },
  },
  "agents": {
    "defaults": {
      "model": "openai/gpt-4o-mini",
      "imageModel": "openai/gpt-4o-mini",
    },
    "mozi": {
      "main": true,
      "skills": [],
    },
  },
  "memory": {
    "backend": "builtin",
  },
  "channels": {
    "routing": {
      "dmAgentId": "mozi",
    },
  },
}
```

This is intentionally minimal. Add lifecycle/memory/channel advanced options later.

Model routing note:

- Use `model` for default text routing.
- Use optional `imageModel` for image-capable override.
- Multi-format inputs are handled through the multimodal/media-understanding pipeline.

## 4) Set required environment variables

At least one model provider key is required.

```bash
export OPENAI_API_KEY="sk-..."
```

If you use Telegram:

```bash
export TELEGRAM_BOT_TOKEN="..."
```

Then add channel config in `config.jsonc`:

```jsonc
{
  "channels": {
    "routing": { "dmAgentId": "mozi" },
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "agentId": "mozi",
    },
  },
}
```

## 5) Start runtime

Build first, then run the compiled CLI from `dist/`:

```bash
pnpm run build
node dist/mozi.mjs runtime start
```

Expected: runtime host starts, channel adapters connect (if enabled), and agent routing is ready.

If `mozi` is globally installed or linked in PATH, you can also run:

```bash
mozi runtime start
```

## 6) First-run checks

- If you see auth errors like `AUTH_MISSING OPENAI_API_KEY`, your env/config key is not loaded.
- If Telegram is enabled but no messages are handled, verify `TELEGRAM_BOT_TOKEN` and `channels.telegram.enabled`.
- If memory appears empty, start with builtin backend and place markdown notes under `~/.mozi/home/mozi/memory/`.

## 7) Where to go next

- Memory internals: `docs/MODULES/memory.md`
- Config reference: `docs/MODULES/config.md`
- Runtime architecture: `docs/SYSTEM.md`

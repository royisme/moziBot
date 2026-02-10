# Mozi (墨子)

<p align="center">
  <img src="docs/assets/logo.png" alt="Mozi" width="200">
</p>

<p align="center">
  Personal AI coding agent that runs securely in containers. Small, focused, and built for daily use.
</p>

## Why Mozi Exists

Mozi is **not** a "build for fun" project, and not a "cover every scenario" platform.

It is built around one practical goal: 
**a personal coding agent you can run every day, safely, with predictable behavior and low maintenance overhead.**

Core logic:

- **Small core, stable runtime**: keep the host process simple and reliable instead of building a giant orchestration platform.
- **Session continuity without context chaos**: use lifecycle-based session segmentation/rotation so long-running usage stays manageable.
- **Memory as a system behavior**: memory file creation/sync/indexing are runtime responsibilities, not manual user chores.
- **Sandbox-first execution**: code/tool execution should be isolated by default, so autonomy does not mean host risk.

Anti-goals:

- Not trying to be an enterprise multi-tenant agent platform.
- Not trying to automate every workflow blindly.
- Not adding features that increase complexity without clear daily value.

Mozi can borrow ideas from projects like OpenClaw, but the product target is different: 
**smaller surface area, clearer control, and better day-to-day operability for a personal setup.**

## Quick Start

```bash
git clone https://github.com/royzhu/mozi.git
cd mozi
pnpm install
```

### Configuration

Create `~/.mozi/config.jsonc`:

```jsonc
{
  "paths": {
    "baseDir": "~/.mozi",
  },
  "models": {
    "providers": {
      "openai": {
        "apiKey": "${OPENAI_API_KEY}",
        "api": "openai-responses",
        "models": [{ "id": "gpt-4o" }],
      },
    },
  },
  "memory": {
    "backend": "builtin",
    "builtin": {
      "sync": {
        "onSessionStart": true,
        "onSearch": true,
        "watch": true,
        "intervalMinutes": 0
      }
    },
    "persistence": {
      "enabled": true,
      "onOverflowCompaction": true,
      "onNewReset": true
    }
  },
  "agents": {
    "defaults": {
      "model": "openai/gpt-4o",
      "lifecycle": {
        "control": {
          "model": "openai/gpt-4o-mini",
          "fallback": ["openai/gpt-4o"]
        },
        "temporal": {
          "enabled": true,
          "activeWindowHours": 12,
          "dayBoundaryRollover": true
        },
        "semantic": {
          "enabled": true,
          "threshold": 0.8,
          "debounceSeconds": 60,
          "reversible": true
        }
      }
    },
    "mozi": {
      "level": "primary",
      "skills": [],
    },
  },
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

Session lifecycle behavior:

- `/new` performs a hard segment rotation (new segment id, old segment archived)
- Temporal auto-rotation runs by default (12h window and day-boundary rollover)
- Semantic rotation can run in background with debounce and reversible rollback

Memory lifecycle behavior:

- Builtin memory syncs local `.md` files into a SQLite index automatically.
- Reindexing triggers on session warmup, before search, or via filesystem watcher.
- Session history can be auto-archived to memory files on context overflow or `/new`.

Set your environment variables:

```env
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=...
```

### Running

Start the Mozi runtime host:

```bash
mozi runtime start
```

## Architecture

Mozi uses a modular architecture with a deliberately compact scope:

- **Runtime Host**: The main process that manages channels, queue scheduling, and session runtime.
- **Channel Adapters**: Integration with messaging platforms (Telegram, Discord).
- **Agents**: LLM-powered entities that execute tasks.
  - **LLM**: Provider abstraction (OpenAI, Anthropic).
  - **Runner**: Executes agents in isolated environments.
  - **Skills**: Capabilities like web search or code execution.
  - **Tools**: Low-level interfaces for agents.
- **Storage**: Persistent state using SQLite and local filesystem.

## Documentation

- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) - Required baseline setup to run Mozi locally
- [docs/SYSTEM.md](docs/SYSTEM.md) - System overview and architecture
- [docs/API.md](docs/API.md) - API reference and interfaces
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) - How to contribute
- [docs/MODULES/memory.md](docs/MODULES/memory.md) - Memory sync and persistence details

## Development Docs

- [dev-docs/ARCHITECTURE.md](dev-docs/ARCHITECTURE.md) - Internal architecture details
- [dev-docs/TECH_STACK.md](dev-docs/TECH_STACK.md) - Technology choices
- [dev-docs/PROGRESS.md](dev-docs/PROGRESS.md) - Development status

## Requirements

- Node.js >= 22.12.0
- [pnpm](https://pnpm.io) (via Corepack recommended)
- [Docker](https://docker.com) (only if sandbox exec is enabled)

## License

MIT

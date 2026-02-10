# AGENTS.md - Mozi Project

## Overview

Mozi is a personal AI coding agent that runs in isolated containers. It bridges messaging platforms (Telegram, Discord) with LLM-powered agents.

## Project Structure

```
mozi/
├── src/                    # Main application source
│   ├── index.ts            # Entry point
│   ├── config.ts           # Configuration
│   ├── logger.ts           # Logging
│   ├── runtime/            # Runtime core + host + channel adapters
│   ├── container/          # Container management
│   ├── storage/            # Database and sessions
│   └── scheduler/          # Task scheduling
├── container/              # Container build files
│   ├── Dockerfile
│   └── agent-runner/       # In-container agent
├── groups/                 # Per-group workspaces
├── data/                   # Runtime data
└── docs/                   # Documentation
```

## Development Rules

### Code Style

- TypeScript strict mode
- Use Biome for formatting and linting
- Prefer `const` over `let`
- Use async/await over callbacks
- Document public APIs with JSDoc

### Naming Conventions

- Files: kebab-case (`container-runner.ts`)
- Types/Interfaces: PascalCase (`ContainerInput`)
- Functions/Variables: camelCase (`runContainerAgent`)
- Constants: SCREAMING_SNAKE_CASE (`MAX_TIMEOUT`)

### Testing

- Unit tests alongside source files (`*.test.ts`)
- Use `pnpm run test` for running tests
- Mock external dependencies
- Aim for 80% coverage on critical paths

### Compatibility Policy (Development Stage)

- Project is currently in active development stage
- By default, DO NOT preserve backward compatibility unless explicitly requested
- Prefer clean replacement over compatibility shims and dual-path logic
- Refactors may remove legacy config fields/APIs directly when improving structure
- If compatibility is required for a specific change, it must be explicitly stated in the task

### Git Workflow

- Commit messages: conventional commits
- Branch naming: `feature/`, `fix/`, `docs/`
- PR reviews required for main branch

## Key Files

- `docs/TASKS.md` - Development task breakdown
- `docs/PROGRESS.md` - Current development status
- `docs/ARCHITECTURE.md` - System design
- `docs/TECH_STACK.md` - Technology choices

## Commands

```bash
pnpm install         # Install dependencies
pnpm run dev         # Development mode
pnpm run build       # Build for production
pnpm run check       # Lint + type check
pnpm run test        # Run tests
pnpm run format      # Format code
```

## Environment Variables

Required:

- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` - LLM provider key

Optional:

- `TELEGRAM_BOT_TOKEN` - Telegram bot token
- `DISCORD_BOT_TOKEN` - Discord bot token
- `LOG_LEVEL` - Logging level (debug, info, warn, error)
- `CONTAINER_RUNTIME` - Container runtime (docker, apple)

## Dependencies

Core:

- `@mariozechner/pi-ai` - LLM integration
- `@mariozechner/pi-agent-core` - Agent runtime
- `telegraf` - Telegram client
- `discord.js` - Discord client
- `pino` - Logging
- `zod` - Validation

## Common Tasks

### Adding a New Channel

1. Create adapter in `src/runtime/adapters/channels/{name}/`
2. Implement `ChannelPlugin` interface
3. Register in `src/runtime/adapters/channels/registry.ts`
4. Add configuration in `src/config.ts`
5. Update documentation

### Adding a New Tool

1. Create tool in `container/agent-runner/src/tools/`
2. Register in tool list
3. Add documentation
4. Write tests

### Debugging Container Issues

1. Check `groups/{folder}/logs/` for container logs
2. Run container manually: `docker run -it mozi-agent /bin/bash`
3. Enable debug logging: `LOG_LEVEL=debug`

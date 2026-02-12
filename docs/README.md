# Mozi System Documentation

This directory contains system documentation designed for AI agents to understand, navigate, and modify the Mozi codebase.

## Purpose

These documents enable Mozi agents to:

1. Understand the system architecture and components
2. Navigate the codebase effectively
3. Make safe modifications and improvements
4. Follow established patterns and conventions

## Document Structure

```
docs/
├── README.md          # This file - documentation entry point
├── SYSTEM.md          # System overview and architecture
├── API.md             # API reference and interfaces
├── CONTRIBUTING.md    # How to contribute and modify the system
├── SECRET_BROKER.md   # Credential broker design (single DB, runtime built-in)
├── CONFIG.md          # Configuration reference
└── MODULES/
    ├── runtime.md     # Runtime system
    ├── agents.md      # Agent system
    ├── channels.md    # Channel adapters
    ├── memory.md      # Memory and persistence
    └── tools.md       # Tools and capabilities
```

## Quick Start for Agents

1. Read [SYSTEM.md](./SYSTEM.md) for overall architecture
2. Read [API.md](./API.md) for interface definitions
3. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before making changes
4. Read [SECRET_BROKER.md](./SECRET_BROKER.md) for credential-management architecture
5. If touching tool execution security, read [MODULES/tools.md](./MODULES/tools.md)

## Quick Start for Users

If you want to run Mozi locally for the first time, start here:

- [GETTING_STARTED.md](./GETTING_STARTED.md) — required config/env/runtime startup steps.

Published CLI package:

- `@royisme/mozi-bot`

Global install examples:

```bash
pnpm add -g @royisme/mozi-bot
# or
bun add -g @royisme/mozi-bot
# or
npm i -g @royisme/mozi-bot
```

## Agent Bootstrap Order (Recommended)

When an agent starts a new task in this repository, read in this order:

1. [../AGENTS.md](../AGENTS.md) - global repository constraints and commands
2. [SYSTEM.md](./SYSTEM.md) - runtime and component topology
3. [API.md](./API.md) - key interfaces and config schema
4. [MODULES/runtime.md](./MODULES/runtime.md) - runtime execution flow and edit map
5. [MODULES/agents.md](./MODULES/agents.md) - agent identity, skills, and tool wiring
6. [MODULES/channels.md](./MODULES/channels.md) - channel adapters and message contracts
7. [MODULES/memory.md](./MODULES/memory.md) - memory backends and persistence flows
8. [MODULES/tools.md](./MODULES/tools.md) - runtime/agent tool surfaces and extension tools

## Directory-Level Module Docs

- [MODULES/runtime.md](./MODULES/runtime.md)
- [MODULES/runtime-host.md](./MODULES/runtime-host.md)
- [MODULES/runtime-core.md](./MODULES/runtime-core.md)
- [MODULES/agents.md](./MODULES/agents.md)
- [MODULES/channels.md](./MODULES/channels.md)
- [MODULES/memory.md](./MODULES/memory.md)
- [MODULES/tools.md](./MODULES/tools.md)
- [MODULES/sandbox.md](./MODULES/sandbox.md)
- [MODULES/config.md](./MODULES/config.md)
- [MODULES/cli.md](./MODULES/cli.md)
- [MODULES/extensions.md](./MODULES/extensions.md)
- [MODULES/multimodal.md](./MODULES/multimodal.md)
- [MODULES/container.md](./MODULES/container.md)
- [MODULES/storage.md](./MODULES/storage.md)

## Key Principles

- **Explicit over implicit**: All patterns and conventions are documented
- **Examples included**: Code examples show correct usage
- **Version aware**: Documents are kept in sync with code
- **Agent-friendly**: Written for AI consumption, not just humans

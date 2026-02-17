# Mozi System Overview

Mozi is a personal AI coding agent that runs in isolated containers, bridging messaging platforms (Telegram, Discord) with LLM-powered agents.

## Core Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Runtime Host                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   Channels   │  │    Queue     │  │  Session Manager │  │
│  │  - Telegram  │  │  Scheduler   │  │                  │  │
│  │  - Discord   │  │              │  │                  │  │
│  │  - Desktop   │  │              │  │                  │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                   │            │
│         └─────────────────┴───────────────────┘            │
│                           │                                 │
│                    ┌──────┴──────┐                         │
│                    │ Agent Core  │                         │
│                    │             │                         │
│                    │ - LLM       │                         │
│                    │ - Tools     │                         │
│                    │ - Skills    │                         │
│                    │ - Memory    │                         │
│                    └─────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

## System Components

### 1. Runtime Host (`src/runtime/`)

The main process that orchestrates all subsystems.

**Key modules:**

- `host/` - Message handling, routing, session lifecycle
- `adapters/channels/` - Platform integrations (Telegram, Discord, Desktop)
- `sandbox/` - Container execution environment
- `context-management/` - Message history and context window

### 2. Agent System (`src/agents/`)

LLM-powered entities that execute tasks.

**Key modules:**

- `runner.ts` - Agent execution coordinator
- `skills/` - Capability definitions and loading
- `workspace/` - Project context management
- `home/` - Agent identity and bootstrap

### 3. Storage (`src/storage/`)

Persistent state management.

**Key modules:**

- `session-store.ts` - Conversation persistence
- `memory/` - Long-term memory and QMD
- Config and state files in `~/.mozi/`

### 4. Extensions (`src/extensions/`)

Plugin system for extending capabilities.

**Key files:**

- `registry.ts` - Extension registration
- `loader.ts` - Dynamic loading
- `builtins/` - Built-in extensions (search, etc.)

## Data Flow

```
User Message
    │
    ▼
Channel Adapter (Telegram/Discord/Desktop)
    │
    ▼
Message Handler
    │
    ├─► Parse command (if command)
    ├─► Route to appropriate handler
    └─► Build context and session
              │
              ▼
        Agent Runner
              │
    ┌─────────┼─────────┐
    │         │         │
    ▼         ▼         ▼
  Tools    Skills    Memory
    │         │         │
    └─────────┴─────────┘
              │
              ▼
        LLM Provider
              │
              ▼
        Response
              │
    ┌─────────┴─────────┐
    │                   │
    ▼                   ▼
Channel          Storage Update
```

## Configuration

Configuration is stored in `~/.mozi/config.jsonc`:

```jsonc
{
  "paths": {
    "baseDir": "~/.mozi",
    "sessions": "sessions",
    "logs": "logs",
  },
  "models": {
    "providers": {
      "provider-name": {
        "apiKey": "${ENV_VAR}",
        "api": "api-type",
        "models": [{ "id": "model-id" }],
      },
    },
  },
  "agents": {
    "defaults": { "model": "provider/model" },
    "agent-name": { "main": true, "skills": [] },
  },
  "channels": {
    "routing": { "dmAgentId": "agent-name" },
    "telegram": { "enabled": true, "botToken": "${TOKEN}", "agentId": "agent-name" },
  },
}
```

## Key Design Patterns

### 1. Plugin Architecture

Channels and extensions use a plugin pattern:

```typescript
interface ChannelPlugin {
  readonly id: string;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  send(peerId: string, message: OutboundMessage): Promise<void>;
  // ...
}
```

### 2. Session Management

Sessions use a segmented lifecycle model:

- `sessionKey` is the stable routing bucket: `agent:{agentId}:{channel}:{scope}:{peerId}`
- each bucket has one mutable `latest` segment and append-only archived history segments
- `/new` always rotates via `rotateSegment` to a new segment id; it does not clear in place
- temporal policy can auto-rotate (`activeWindowHours`, `dayBoundaryRollover`)
- semantic policy can auto-rotate with debounce and reversible rollback (rollback merges current segment messages back into previous segment)

### 3. Context Pruning

Messages are automatically pruned when approaching context window limits:

- Soft trim: Remove old messages
- Hard clear: Reset to system prompt only

### 4. Sandbox Execution

Tools can run in isolated containers:

- `off` - No sandbox
- `docker` - Docker containers
- `apple` - Apple Virtualization Framework

## File Organization

```
src/
├── index.ts              # Entry point
├── config.ts             # Configuration types and loading
├── logger.ts             # Logging setup
├── cli/                  # Command line interface
├── runtime/              # Runtime host and core
├── agents/               # Agent system
├── memory/               # Memory and persistence
├── extensions/           # Extension system
└── utils/                # Shared utilities
```

## Important Conventions

1. **Environment Variables**: Use `${VAR_NAME}` syntax in config for secrets
2. **Error Handling**: Use specific error types, propagate with context
3. **Logging**: Use structured logging with `logger.info/debug/warn/error`
4. **Async/Await**: Prefer async/await over callbacks
5. **Type Safety**: Strict TypeScript, no `any` without justification

## Entry Points for Modifications

- **Add a channel**: `src/runtime/adapters/channels/{name}/`
- **Add a tool**: `src/agents/tools/`
- **Add a skill**: `src/agents/skills/`
- **Add an extension**: `src/extensions/`
- **Modify message handling**: `src/runtime/host/message-handler.ts`
- **Modify agent behavior**: `src/runtime/agent-manager.ts`

See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed modification guidelines.

# Contributing to Mozi

This document provides guidelines for AI agents and developers who want to modify or extend the Mozi system.

## Before Making Changes

1. **Read the system overview**: [SYSTEM.md](./SYSTEM.md)
2. **Understand the architecture**: [dev-docs/ARCHITECTURE.md](../dev-docs/ARCHITECTURE.md)
3. **Check existing patterns**: Look at similar implementations in the codebase
4. **Run tests**: Ensure existing functionality works

## Development Workflow

### 1. Setup

```bash
# Install dependencies
pnpm install

# Run tests
pnpm run test

# Run linting
pnpm run check
```

### 2. Making Changes

#### Adding a New Channel

**Location**: `src/runtime/adapters/channels/{channel-name}/`

**Required files**:

- `plugin.ts` - Main plugin implementation
- `plugin.test.ts` - Unit tests
- `types.ts` - Channel-specific types (if needed)

**Template**:

```typescript
import type { ChannelPlugin, InboundMessage, OutboundMessage } from "../plugin";

export class MyChannelPlugin implements ChannelPlugin {
  readonly id = "my-channel";
  readonly capabilities = {
    supportsMedia: true,
    supportsThreads: false,
    supportsEditing: true,
  };

  async initialize(): Promise<void> {
    // Setup connection
  }

  async shutdown(): Promise<void> {
    // Cleanup
  }

  async send(peerId: string, message: OutboundMessage): Promise<void> {
    // Send message logic
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    // Register message handler
  }
}
```

**Registration**: Add to `src/runtime/adapters/channels/registry.ts`

#### Adding a New Tool

**Location**: `src/agents/tools/`

**Pattern**:

```typescript
import type { AgentTool } from "@mariozechner/pi-agent-core";

export function createMyTool(config: MyToolConfig): AgentTool {
  return {
    name: "my_tool",
    description: "Description of what the tool does",
    parameters: {
      type: "object",
      properties: {
        param1: {
          type: "string",
          description: "Description of param1",
        },
      },
      required: ["param1"],
    },
    execute: async (args) => {
      // Tool logic
      return { success: true, result: "..." };
    },
  };
}
```

**Registration**: Add to `AgentManager.buildTools()` in `src/runtime/agent-manager.ts`

#### Adding a New Skill

**Location**: `src/agents/skills/`

1. Create skill directory: `src/agents/skills/{skill-name}/`
2. Add `index.ts` with skill definition
3. Add to `src/agents/skills/index.ts`

**Skill structure**:

```typescript
export const mySkill = {
  id: "my-skill",
  name: "My Skill",
  description: "What this skill does",

  tools: [
    // Tool definitions
  ],

  prompts: {
    system: "Additional system prompt content",
  },
};
```

### 3. Testing

**Unit Tests**:

```typescript
import { describe, it, expect } from "vitest";
import { createMyTool } from "./my-tool";

describe("my-tool", () => {
  it("should execute successfully", async () => {
    const tool = createMyTool({});
    const result = await tool.execute({ param1: "test" });
    expect(result.success).toBe(true);
  });
});
```

**Integration Tests**:

Place in `src/{module}/{feature}.integration.test.ts`

### 4. Code Style

- **TypeScript**: Strict mode enabled
- **Formatting**: Biome (oxfmt) - run `pnpm run format`
- **Linting**: oxlint - run `pnpm run lint`
- **Naming**: camelCase for functions/variables, PascalCase for types

### 5. Documentation

Update relevant documentation:

- API changes → [API.md](./API.md)
- New features → [SYSTEM.md](./SYSTEM.md)
- Architecture changes → [dev-docs/](../dev-docs/)

## Common Patterns

### Error Handling

```typescript
// Always wrap errors with context
throw new AgentError(`Failed to process message: ${err.message}`, "PROCESSING_ERROR", err);

// Use specific error types
if (isContextOverflowError(err)) {
  // Handle overflow
}
```

### Logging

```typescript
import { logger } from "../logger";

// Structured logging
logger.info({ sessionKey, agentId, messageCount: messages.length }, "Session initialized");

// Debug logging
logger.debug({ context: "some-context" }, "Detailed debug info");
```

### Async Patterns

```typescript
// Prefer async/await
async function processMessage(message: InboundMessage): Promise<void> {
  try {
    const agent = await this.agentManager.getAgent(sessionKey);
    await agent.prompt(message.text);
  } catch (err) {
    logger.error({ err }, "Failed to process message");
    throw err;
  }
}

// Handle cleanup in finally
const tempFile = createTempFile();
try {
  await processFile(tempFile);
} finally {
  await cleanup(tempFile);
}
```

### Configuration Access

```typescript
// Use config resolver
const homeDir = this.resolveHomeDir(agentId);
const workspaceDir = this.resolveWorkspaceDir(agentId);

// Access nested config safely
const routing = this.config.channels?.routing;
```

## Safety Guidelines

### DO

- ✅ Write tests for new functionality
- ✅ Handle errors gracefully
- ✅ Use TypeScript strict types
- ✅ Follow existing patterns
- ✅ Add logging for important operations
- ✅ Clean up resources in `finally` blocks

### DON'T

- ❌ Use `any` without justification
- ❌ Ignore error cases
- ❌ Modify multiple unrelated things in one PR
- ❌ Break backward compatibility without migration
- ❌ Add untested code paths
- ❌ Log sensitive information (API keys, tokens)

## Architecture Principles

### 1. Separation of Concerns

- **Runtime** handles orchestration
- **Agents** handle LLM interaction
- **Channels** handle platform-specifics
- **Tools** handle capabilities

### 2. Plugin Architecture

New features should be pluggable:

- Implement the interface
- Register in the appropriate registry
- No changes to core required

### 3. Session Isolation

Each conversation is isolated:

- Separate context
- Separate tool instances
- Separate memory scope

### 4. Graceful Degradation

When features fail:

- Log the error
- Fall back to safe defaults
- Continue operating if possible

## Review Checklist

Before submitting changes:

- [ ] Tests pass (`pnpm run test`)
- [ ] Linting passes (`pnpm run check`)
- [ ] Type checking passes (`pnpm run check`)
- [ ] Documentation updated
- [ ] Examples added for complex features
- [ ] Error cases handled
- [ ] Logging added for debugging
- [ ] No sensitive data exposed

## Getting Help

- Check [SYSTEM.md](./SYSTEM.md) for architecture
- Check [API.md](./API.md) for interfaces
- Check [dev-docs/](../dev-docs/) for design decisions
- Review similar implementations in codebase
- Run tests to understand behavior

## Example: Complete Feature Addition

See `src/runtime/adapters/channels/local-desktop/` for a complete example of:

- Plugin implementation
- Type definitions
- Unit tests
- Integration with registry

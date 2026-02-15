---
name: coding-assistant
description: Run coding agents (Claude Code, Codex, OpenCode, Pi) via exec tool for programmatic software development tasks.
---

# Coding Assistant

Use this skill to run coding agents for software development tasks. The coding agents are interactive terminal applications that require PTY mode.

## When To Use

- "help me code this feature"
- "refactor this file"
- "write a test for this"
- "debug this error"
- "review this code"

## Supported Agents

| Agent        | Command    | Best For                       |
| ------------ | ---------- | ------------------------------ |
| Claude Code  | `claude`   | Complex refactoring, debugging |
| OpenAI Codex | `codex`    | Quick implementations          |
| OpenCode     | `opencode` | Multi-file changes             |
| Pi           | `pi`       | Lightweight tasks              |

## Basic Usage

```bash
# Simple task
claude "Add input validation to the login function"

# With context
claude --verbose "Refactor this error handling to use custom exceptions"

# Multi-file task
codex "Create a comprehensive test suite for the user service"
```

## Important: PTY Mode Required

Always use PTY mode when running coding agents:

```typescript
{
  command: "claude",
  args: ["Implement a rate limiter middleware"],
  pty: true  // Required!
}
```

Without PTY, agents may hang or produce broken output.

## Workflow

1. **Analyze** the current code structure
2. **Choose** appropriate agent for the task complexity
3. **Run** with clear, specific instructions
4. **Review** the changes made
5. **Test** the results

## Examples

### Refactoring

```bash
claude "Extract this validation logic into a separate function"
```

### Debugging

```bash
claude "Find and fix the memory leak in this module"
```

### Testing

```bash
codex "Generate unit tests for all public methods in this class"
```

### Code Review

```bash
pi "Review this function for potential edge cases"
```

## Safety Rules

1. Always review changes before committing
2. Run tests after agent modifications
3. Use version control to rollback if needed
4. Never expose secrets or API keys in prompts
5. Keep workspace directory clean before starting

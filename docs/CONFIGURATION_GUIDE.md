# Mozi Configuration Guide

This guide documents all configurable options in Mozi, organized by functional modules.

**Config File Location**: `~/.mozi/config.jsonc` (JSON with Comments)

---

## Table of Contents

1.  [Quick Start](#quick-start)
2.  [Configuration Basics](#configuration-basics)
3.  [Paths](#paths)
4.  [Models & Aliases](#models--aliases)
5.  [Agents](#agents)
6.  [Channels](#channels)
7.  [Session](#session)
8.  [Runtime](#runtime)
9.  [Sandbox](#sandbox)
10. [Skills](#skills)
11. [Memory](#memory)
12. [Voice](#voice)
13. [Browser](#browser)
14. [Extensions](#extensions)
15. [ACP](#acp)
16. [Hooks](#hooks)
17. [Logging](#logging)

---

## Quick Start

Here's a minimal starter configuration:

```jsonc
{
  "$schema": "https://mozi.dev/schema/config.json",

  "models": {
    "providers": {
      "openai": {
        "api": "openai-responses",
        "apiKey": "${OPENAI_API_KEY}",
        "models": [
          { "id": "gpt-4o", "name": "GPT-4o" },
          { "id": "gpt-4o-mini", "name": "GPT-4o Mini" }
        ]
      }
    },
    "aliases": {
      "smart": "openai/gpt-4o",
      "fast": "openai/gpt-4o-mini"
    }
  },

  "agents": {
    "defaults": {
      "model": "smart",
      "fastModel": "fast"
    },
    "mozi": {
      "main": true,
      "systemPrompt": "You are a helpful assistant."
    }
  },

  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}"
    }
  },

  "logging": {
    "level": "info"
  }
}
```

---

## Configuration Basics

### Special Features

#### `$include` - Include Other Config Files

Split your config across multiple files:

```jsonc
{
  "$include": ["base.jsonc", "secrets.jsonc"],
  // Override included config here
}
```

- Files are deep-merged
- Arrays are concatenated
- Max recursion depth: 10

#### Environment Variable Substitution

Reference environment variables with `${VAR_NAME}`:

```jsonc
{
  "models": {
    "providers": {
      "openai": {
        "apiKey": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

Mozi loads `.env` and `.env.var` from the config directory.

---

## Paths

Configure directory locations.

```jsonc
{
  "paths": {
    "baseDir": "~/.mozi",
    "sessions": "~/.mozi/sessions",
    "logs": "~/.mozi/logs",
    "skills": "~/.mozi/skills",
    "workspace": "~/workspace"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseDir` | string | `~/.mozi` | Base directory for Mozi data |
| `sessions` | string | `<baseDir>/sessions` | Session storage directory |
| `logs` | string | `<baseDir>/logs` | Log storage directory |
| `skills` | string | - | Skills directory |
| `workspace` | string | - | Agent workspace directory |

---

## Models & Aliases

Configure model providers and create friendly aliases for long model IDs.

```jsonc
{
  "models": {
    "mode": "merge",
    "providers": {
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "${OPENAI_API_KEY}",
        "auth": "api-key",
        "api": "openai-responses",
        "headers": {
          "X-Organization": "my-org"
        },
        "authHeader": true,
        "models": [
          {
            "id": "gpt-4o",
            "name": "GPT-4o",
            "api": "openai-responses",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": {
              "input": 5.0,
              "output": 15.0,
              "cacheRead": 2.5,
              "cacheWrite": 7.5
            },
            "contextWindow": 128000,
            "maxTokens": 4096,
            "compat": {
              "supportsStore": true,
              "supportsDeveloperRole": true,
              "supportsReasoningEffort": true,
              "maxTokensField": "max_completion_tokens"
            }
          }
        ]
      }
    },
    "aliases": {
      "smart": "openai/gpt-4o",
      "fast": "openai/gpt-4o-mini",
      "seed-code": "volcengine/doubao-seed-2-0-code-preview-260215"
    }
  }
}
```

### `models.mode`

| Value | Description |
|-------|-------------|
| `merge` | Merge with default providers (default) |
| `replace` | Replace all default providers |

### Provider API Types

| API Type | Description |
|----------|-------------|
| `openai-responses` | OpenAI Responses API |
| `openai-completions` | OpenAI Completions API |
| `openai-codex-responses` | OpenAI Codex Responses |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |
| `google-gemini-cli` | Google Gemini CLI |
| `cli-backend` | Custom CLI backend |
| `ollama` | Ollama local models |

### Model Input Types

| Type | Description |
|------|-------------|
| `text` | Text input |
| `image` | Image input |
| `audio` | Audio input |
| `video` | Video input |
| `file` | File input |

### Aliases Rules

- Alias keys **cannot contain `/`**
- Aliases are case-insensitive at runtime
- Use aliases anywhere a model ref is expected:
  - `agents.defaults.model`
  - `/switch` command
  - Session overrides

---

## Agents

Configure agent behavior, models, tools, and lifecycle.

```jsonc
{
  "agents": {
    "defaults": {
      "model": "openai/gpt-4o",
      "fastModel": {
        "primary": "openai/gpt-4o-mini",
        "fallbacks": ["openai/gpt-3.5-turbo"]
      },
      "imageModel": "openai/gpt-4o",
      "tools": ["read_file", "write_file"],
      "subagents": {
        "allow": ["worker", "researcher"],
        "promptMode": "minimal"
      },
      "sandbox": {
        "mode": "docker",
        "workspaceAccess": "rw"
      },
      "exec": {
        "allowlist": ["git", "ls", "cat"],
        "allowedSecrets": ["GITHUB_TOKEN"]
      },
      "heartbeat": {
        "enabled": true,
        "every": "30m",
        "prompt": "Check for any pending tasks."
      },
      "lifecycle": {
        "control": {
          "model": "openai/gpt-4o-mini",
          "fallback": ["openai/gpt-3.5-turbo"]
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
      },
      "thinking": "medium",
      "output": {
        "showThinking": false,
        "reasoningLevel": "on",
        "showToolCalls": "summary"
      },
      "contextPruning": {
        "enabled": true,
        "softTrimRatio": 0.5,
        "hardClearRatio": 0.7,
        "keepLastAssistants": 3,
        "minPrunableChars": 20000,
        "softTrim": {
          "maxChars": 4000,
          "headChars": 1500,
          "tailChars": 1500
        },
        "hardClearPlaceholder": "[older messages trimmed]",
        "protectedTools": ["read_file"]
      },
      "contextTokens": 128000,
      "timeoutSeconds": 300
    },
    "mozi": {
      "main": true,
      "name": "Mozi",
      "home": "~/.mozi",
      "workspace": "~/workspace",
      "systemPrompt": "You are a helpful AI assistant.",
      "model": "smart",
      "skills": ["web-search", "memory"]
    },
    "coder": {
      "name": "Coder",
      "systemPrompt": "You write clean, well-tested code."
    }
  }
}
```

### Agent Model Configuration

Models can be specified as a string:

```jsonc
{
  "model": "openai/gpt-4o"
}
```

Or with fallbacks:

```jsonc
{
  "model": {
    "primary": "openai/gpt-4o",
    "fallbacks": ["openai/gpt-4o-mini", "openai/gpt-3.5-turbo"]
  }
}
```

### Thinking Levels

| Level | Description |
|-------|-------------|
| `off` | No thinking |
| `minimal` | Minimal thinking |
| `low` | Low thinking effort |
| `medium` | Medium thinking effort |
| `high` | High thinking effort |
| `xhigh` | Extra high thinking effort |

### Subagent Prompt Mode

| Mode | Description |
|------|-------------|
| `minimal` | Minimal prompt for subagents |
| `full` | Full context for subagents |

### Output Rendering

| Field | Type | Description |
|-------|------|-------------|
| `showThinking` | boolean | Show thinking process |
| `reasoningLevel` | `off` \| `on` \| `stream` | Reasoning visibility |
| `showToolCalls` | `off` \| `summary` | Tool call visibility |

### Context Pruning

Automatically manage context window size:

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable pruning |
| `softTrimRatio` | number | Start soft trimming at this ratio (0-1) |
| `hardClearRatio` | number | Hard clear at this ratio (0-1) |
| `keepLastAssistants` | number | Keep N last assistant messages |
| `minPrunableChars` | number | Minimum chars before pruning |
| `protectedTools` | string[] | Never prune messages with these tools |

---

## Channels

Configure Telegram, Discord, and LocalDesktop channels.

```jsonc
{
  "channels": {
    "dmScope": "per-peer",
    "routing": {
      "dmAgentId": "mozi",
      "groupAgentId": "mozi"
    },
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "allowedChats": [1001, "alice"],
      "dmScope": "per-peer",
      "dmPolicy": "allowlist",
      "groupPolicy": "allowlist",
      "allowFrom": [1001, 2002],
      "groups": {
        "-1003504669621": {
          "requireMention": false,
          "allowFrom": [2002],
          "agentId": "dev-pm"
        }
      },
      "dmHistoryLimit": 100,
      "dms": {
        "1001": { "historyLimit": 200 }
      },
      "streamMode": "partial",
      "polling": {
        "timeoutSeconds": 30,
        "maxRetryTimeMs": 120000,
        "retryInterval": "exponential",
        "silentRunnerErrors": true
      },
      "statusReactions": {
        "enabled": true,
        "emojis": {
          "queued": "⏳",
          "thinking": "🤔",
          "tool": "🔧",
          "done": "✅",
          "error": "❌"
        }
      },
      "agentId": "mozi"
    },
    "discord": {
      "enabled": true,
      "botToken": "${DISCORD_BOT_TOKEN}",
      "allowedGuilds": ["guild-1"],
      "allowedChannels": ["channel-1"],
      "dmPolicy": "open",
      "groupPolicy": "allowlist",
      "allowFrom": [1001],
      "guilds": {
        "guild-1": {
          "requireMention": true,
          "allowFrom": [2002],
          "allowRoles": ["role-1", 42],
          "roleRouting": {
            "role-1": { "agentId": "dev-pm" }
          },
          "agentId": "mozi"
        }
      },
      "dmScope": "per-peer",
      "agentId": "mozi"
    },
    "localDesktop": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 3987,
      "authToken": "local-dev-token",
      "allowOrigins": ["http://127.0.0.1:5173", "tauri://localhost"],
      "widget": {
        "mode": "auto",
        "uiMode": "voice",
        "voiceInputMode": "ptt",
        "voiceOutputEnabled": true,
        "textOutputEnabled": false
      }
    }
  }
}
```

### DM Scope

Controls session isolation for direct messages:

| Value | Description |
|-------|-------------|
| `main` | Single shared session |
| `per-peer` | Session per peer |
| `per-channel-peer` | Session per (channel, peer) |
| `per-account-channel-peer` | Session per (account, channel, peer) |

### Stream Mode

| Value | Description |
|-------|-------------|
| `off` | No streaming |
| `partial` | Partial streaming |
| `full` | Full streaming |

### Local Desktop Widget Mode

| Value | Description |
|-------|-------------|
| `auto` | Start when desktop detected (default) |
| `on` | Force start |
| `off` | Disable |

### Local Desktop UI Mode

| Value | Description |
|-------|-------------|
| `voice` | Voice-first interface |
| `text` | Text-first interface |

### Voice Input Mode

| Value | Description |
|-------|-------------|
| `ptt` | Push-to-talk |
| `vad` | Voice activity detection |

---

## Session

Configure session management and reset policies.

```jsonc
{
  "session": {
    "dmScope": "per-peer",
    "mainKey": "main",
    "identityLinks": {
      "telegram:1001": ["discord:2002", "local:user"]
    },
    "reset": {
      "mode": "daily",
      "atHour": 4,
      "idleMinutes": 1440
    },
    "resetByType": {
      "direct": { "mode": "daily", "atHour": 4 },
      "group": { "mode": "disabled" },
      "thread": { "mode": "idle", "idleMinutes": 480 }
    },
    "resetByChannel": {
      "telegram": { "mode": "daily", "atHour": 3 }
    }
  }
}
```

### Reset Modes

| Mode | Description |
|------|-------------|
| `daily` | Reset daily at `atHour` |
| `idle` | Reset after `idleMinutes` of inactivity |
| `disabled` | Never auto-reset |

---

## Runtime

Configure queue, cron jobs, auth, and hooks.

```jsonc
{
  "runtime": {
    "sanitizeToolSchema": true,
    "queue": {
      "mode": "collect",
      "collectWindowMs": 500,
      "maxBacklog": 4
    },
    "cron": {
      "jobs": [
        {
          "id": "heartbeat",
          "name": "Hourly Check",
          "schedule": { "kind": "every", "everyMs": 3600000 },
          "payload": { "kind": "systemEvent", "text": "heartbeat" },
          "enabled": true
        },
        {
          "id": "daily-report",
          "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "America/New_York" },
          "payload": {
            "kind": "sendMessage",
            "channel": "telegram",
            "target": "1001",
            "message": "Good morning! Here's your daily report."
          },
          "enabled": true
        },
        {
          "id": "one-time",
          "schedule": { "kind": "at", "atMs": 1735689600000 },
          "payload": { "kind": "agentTurn", "sessionKey": "main", "agentId": "mozi" }
        }
      ]
    },
    "auth": {
      "enabled": true,
      "store": "sqlite",
      "masterKeyEnv": "MOZI_MASTER_KEY",
      "defaultScope": "agent"
    },
    "hooks": {
      "enabled": true,
      "paths": ["~/.mozi/hooks"]
    }
  }
}
```

### Queue Modes

| Mode | Description |
|------|-------------|
| `followup` | Queue as followups |
| `collect` | Collect within window |
| `interrupt` | Interrupt current task |
| `steer` | Steer current task |
| `steer-backlog` | Steer with backlog |

### Cron Schedule Types

| Kind | Fields |
|------|--------|
| `at` | `atMs` (timestamp) |
| `every` | `everyMs`, `anchorMs` |
| `cron` | `expr` (cron expression), `tz` (timezone) |

### Cron Payload Types

| Kind | Description |
|------|-------------|
| `systemEvent` | Inject system event |
| `agentTurn` | Trigger agent turn |
| `sendMessage` | Send message to channel |

---

## Sandbox

Configure code execution sandbox (Apple VM or Docker).

```jsonc
{
  "sandbox": {
    "mode": "docker",
    "autoBootstrapOnStart": true,
    "workspaceAccess": "rw",
    "docker": {
      "image": "ubuntu:22.04",
      "workdir": "/workspace",
      "env": { "PATH": "/usr/local/bin" },
      "network": "bridge",
      "mounts": ["/host/path:/container/path"]
    },
    "apple": {
      "image": "macos:sonoma",
      "workdir": "/Users/me/workspace",
      "backend": "vibebox",
      "vibebox": {
        "enabled": true,
        "binPath": "/usr/local/bin/vibebox",
        "projectRoot": "~/workspace",
        "timeoutSeconds": 300,
        "provider": "auto"
      }
    }
  }
}
```

### Sandbox Modes

| Mode | Description |
|------|-------------|
| `off` | No sandbox |
| `apple-vm` | Apple Virtualization Framework |
| `docker` | Docker containers |

### Workspace Access

| Value | Description |
|-------|-------------|
| `none` | No workspace access |
| `ro` | Read-only access |
| `rw` | Read-write access |

---

## Skills

Configure skill loading and installation.

```jsonc
{
  "skills": {
    "dirs": ["~/.mozi/skills", "/usr/local/mozi/skills"],
    "installDir": "~/.mozi/skills/installed",
    "allowBundled": ["web-search", "memory"],
    "install": {
      "nodeManager": "pnpm"
    }
  }
}
```

---

## Memory

Configure long-term memory with RAG (Retrieval-Augmented Generation).

```jsonc
{
  "memory": {
    "backend": "builtin",
    "citations": "auto",
    "builtin": {
      "sync": {
        "onSessionStart": true,
        "onSearch": true,
        "watch": true,
        "watchDebounceMs": 1500,
        "intervalMinutes": 0,
        "forceOnFlush": true
      }
    },
    "qmd": {
      "command": "qmd",
      "searchMode": "vsearch",
      "includeDefaultMemory": true,
      "paths": [
        { "name": "notes", "path": "~/notes", "pattern": "**/*.md" },
        { "name": "docs", "path": "~/docs" }
      ],
      "update": {
        "interval": "1h",
        "debounceMs": 2000,
        "onBoot": true,
        "embedInterval": "24h"
      },
      "limits": {
        "maxResults": 10,
        "maxSnippetChars": 2000,
        "maxInjectedChars": 8000,
        "timeoutMs": 5000
      },
      "sessions": {
        "enabled": true,
        "exportDir": "~/.mozi/memory/sessions",
        "retentionDays": 30
      },
      "scope": {
        "default": "allow",
        "rules": [
          {
            "action": "deny",
            "match": { "channel": "telegram" }
          }
        ]
      },
      "reliability": {
        "maxRetries": 2,
        "retryBackoffMs": 500,
        "circuitBreakerThreshold": 3,
        "circuitOpenMs": 30000
      },
      "recall": {
        "mmr": { "enabled": true, "lambda": 0.7 },
        "temporalDecay": { "enabled": true, "halfLifeDays": 30 },
        "metrics": { "enabled": false, "sampleRate": 0.1 }
      }
    },
    "embedded": {
      "enabled": true,
      "provider": "openai",
      "model": "text-embedding-3-small",
      "remote": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "${OPENAI_API_KEY}",
        "timeoutMs": 30000,
        "batchSize": 100
      },
      "store": {
        "path": "~/.mozi/memory/vector",
        "vector": { "enabled": true }
      },
      "chunking": { "tokens": 512, "overlap": 64 },
      "sync": {
        "onSessionStart": true,
        "onSearch": true,
        "watch": true,
        "watchDebounceMs": 1500,
        "intervalMinutes": 0,
        "forceOnFlush": true
      },
      "query": {
        "maxResults": 10,
        "minScore": 0.7,
        "hybrid": {
          "enabled": true,
          "vectorWeight": 0.6,
          "textWeight": 0.4,
          "candidateMultiplier": 3
        }
      },
      "cache": { "enabled": true, "maxEntries": 1000 },
      "sources": ["memory", "sessions"],
      "recall": {
        "mmr": { "enabled": true, "lambda": 0.7 },
        "temporalDecay": { "enabled": true, "halfLifeDays": 30 },
        "metrics": { "enabled": false, "sampleRate": 0.1 }
      }
    },
    "persistence": {
      "enabled": true,
      "onOverflowCompaction": true,
      "onNewReset": true,
      "preFlushThresholdPercent": 80,
      "preFlushCooldownMinutes": 30,
      "maxMessages": 12,
      "maxChars": 4000,
      "timeoutMs": 1500
    }
  }
}
```

### Memory Backends

| Backend | Description |
|---------|-------------|
| `builtin` | Local trigram search (default) |
| `qmd` | QMD external memory system |
| `embedded` | Vector embeddings |

### Citation Mode

| Mode | Description |
|------|-------------|
| `auto` | Cite when relevant (default) |
| `always` | Always cite sources |
| `never` | Never cite sources |

---

## Voice

Configure speech-to-text (STT), text-to-speech (TTS), voice activity detection (VAD), and wake words.

```jsonc
{
  "voice": {
    "stt": {
      "strategy": "local-first",
      "local": {
        "provider": "whisper.cpp",
        "binPath": "/usr/local/bin/whisper",
        "modelPath": "/models/ggml-large-v3-turbo.bin",
        "language": "en",
        "threads": 4,
        "useCoreML": true,
        "useMetal": true,
        "timeoutMs": 30000
      },
      "remote": {
        "provider": "openai",
        "endpoint": "https://api.openai.com/v1/audio/transcriptions",
        "apiKey": "${OPENAI_API_KEY}",
        "model": "whisper-1",
        "headers": { "X-Custom": "value" },
        "timeoutMs": 30000
      }
    },
    "tts": {
      "strategy": "fallback-chain",
      "maxChars": 1500,
      "providerOrder": ["openai", "elevenlabs", "edge"],
      "edge": {
        "enabled": true,
        "voice": "en-US-AriaNeural",
        "rate": "+0%",
        "pitch": "+0Hz",
        "format": "audio-24khz-48kbitrate-mono-mp3"
      },
      "openai": {
        "enabled": true,
        "apiKey": "${OPENAI_API_KEY}",
        "model": "gpt-4o-mini-tts",
        "voice": "alloy",
        "format": "mp3",
        "timeoutMs": 20000
      },
      "elevenlabs": {
        "enabled": true,
        "apiKey": "${ELEVENLABS_API_KEY}",
        "voiceId": "voice-123",
        "modelId": "eleven_multilingual_v2",
        "format": "mp3_22050_32",
        "applyTextNormalization": "auto",
        "languageCode": "en",
        "voiceSettings": {
          "stability": 0.5,
          "similarityBoost": 0.75,
          "style": 0.1,
          "useSpeakerBoost": true,
          "speed": 1.0
        },
        "timeoutMs": 20000
      }
    },
    "vad": {
      "enabled": true,
      "startThreshold": 0.02,
      "endThreshold": 0.012,
      "silenceMs": 1500,
      "minSpeechMs": 350,
      "maxSpeechMs": 15000
    },
    "wake": {
      "enabled": true,
      "activationMode": "hybrid",
      "keywords": ["mozi", "墨子"],
      "sensitivity": 0.7
    },
    "ui": {
      "phaseMapping": {
        "idle": { "color": "#808080", "effect": "idle", "intensity": 0.5 },
        "listening": { "color": "#5BC0FF", "effect": "wave", "intensity": 0.8 },
        "thinking": { "color": "#FFD700", "effect": "pulse", "intensity": 0.7 },
        "speaking": { "color": "#00FF7A", "effect": "orbit", "intensity": 1.0 },
        "executing": { "color": "#FF6B00", "effect": "glow", "intensity": 0.9 },
        "error": { "color": "#FF0000", "effect": "pulse", "intensity": 1.0 }
      }
    }
  }
}
```

### STT Strategy

| Strategy | Description |
|----------|-------------|
| `local-only` | Only use local STT |
| `remote-only` | Only use remote STT |
| `local-first` | Try local first, fallback to remote |

### STT Remote Providers

| Provider | Description |
|----------|-------------|
| `openai` | OpenAI Whisper API |
| `groq` | Groq Whisper API |
| `deepgram` | Deepgram STT |
| `custom` | Custom endpoint |

### TTS Strategy

| Strategy | Description |
|----------|-------------|
| `provider-only` | Use primary provider only |
| `fallback-chain` | Try providers in order |

### TTS Provider Order

Array of: `edge`, `openai`, `elevenlabs`

### Wake Word Activation Mode

| Mode | Description |
|------|-------------|
| `click` | Button only |
| `wake-word` | Wake word only |
| `hybrid` | Both wake word and button |

### UI Effects

| Effect | Description |
|--------|-------------|
| `idle` | Static idle state |
| `pulse` | Pulsing animation |
| `orbit` | Orbiting particles |
| `glow` | Glowing effect |
| `wave` | Wave animation |

### VAD Validation Rules

- `startThreshold >= endThreshold`
- `minSpeechMs <= maxSpeechMs`

---

## Browser

Configure browser automation with extension relay or CDP.

```jsonc
{
  "browser": {
    "enabled": true,
    "profiles": {
      "chrome-extension": {
        "driver": "extension",
        "cdpUrl": "http://127.0.0.1:9222"
      },
      "chrome-direct": {
        "driver": "cdp",
        "cdpUrl": "http://127.0.0.1:9223"
      }
    },
    "defaultProfile": "chrome-extension",
    "relay": {
      "enabled": true,
      "bindHost": "127.0.0.1",
      "port": 9222,
      "authToken": "${BROWSER_RELAY_TOKEN}"
    }
  }
}
```

### Browser Drivers

| Driver | Description |
|--------|-------------|
| `extension` | Chrome extension relay |
| `cdp` | Direct Chrome DevTools Protocol |

### Security Rules

- CDP URLs **must use loopback addresses** (localhost, 127.0.0.1, ::1)
- CDP URLs **must have explicit port**
- `relay.authToken` is **required** when relay is enabled with extension driver

---

## Extensions

Configure extensions and MCP servers.

```jsonc
{
  "extensions": {
    "enabled": true,
    "allow": ["web-tavily", "brave-search", "memory-recall"],
    "deny": ["unsafe-extension"],
    "load": {
      "paths": ["~/.mozi/extensions", "/usr/local/mozi/extensions"]
    },
    "entries": {
      "web-tavily": {
        "enabled": true,
        "config": { "apiKey": "${TAVILY_API_KEY}" }
      },
      "brave-search": {
        "enabled": true
      }
    },
    "installs": {
      "custom-extension": {
        "source": "npm",
        "spec": "custom-extension@1.0.0",
        "installedAt": "2024-01-01T00:00:00Z"
      }
    },
    "mcpServers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/workspace"],
        "env": { "NODE_ENV": "production" },
        "enabled": true,
        "timeout": 30000
      },
      "postgres": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"],
        "enabled": false
      }
    },
    "policy": {
      "capabilities": "warn"
    }
  }
}
```

### Extension Sources

| Source | Description |
|--------|-------------|
| `npm` | NPM package |
| `path` | Local path |
| `archive` | Archive file |
| `git` | Git repository |

### Policy Capabilities

| Value | Description |
|-------|-------------|
| `warn` | Warn on capability mismatch |
| `enforce` | Enforce capability restrictions |

### MCP Server Timeout

- Range: 1000-120000 ms

---

## ACP

Configure Agent Control Protocol runtime.

```jsonc
{
  "acp": {
    "enabled": true,
    "dispatch": { "enabled": true },
    "backend": "builtin",
    "defaultAgent": "mozi",
    "allowedAgents": ["mozi", "coder", "researcher"],
    "maxConcurrentSessions": 10,
    "stream": {
      "coalesceIdleMs": 100,
      "maxChunkChars": 1024
    },
    "runtime": {
      "ttlMinutes": 60,
      "installCommand": "pnpm install"
    }
  }
}
```

---

## Hooks

Configure session memory hooks.

```jsonc
{
  "hooks": {
    "sessionMemory": {
      "enabled": true,
      "messages": 10,
      "llmSlug": true,
      "model": "openai/gpt-4o-mini",
      "timeoutMs": 5000
    }
  }
}
```

---

## Logging

Configure log verbosity.

```jsonc
{
  "logging": {
    "level": "info"
  }
}
```

### Log Levels

| Level | Description |
|-------|-------------|
| `fatal` | Fatal errors only |
| `error` | Errors |
| `warn` | Warnings |
| `info` | Info (default) |
| `debug` | Debug output |
| `trace` | Trace output |

---

## Full Example

Here's a complete example showcasing many features:

```jsonc
{
  "$schema": "https://mozi.dev/schema/config.json",
  "$include": ["secrets.jsonc"],

  "models": {
    "providers": {
      "openai": {
        "api": "openai-responses",
        "apiKey": "${OPENAI_API_KEY}",
        "models": [
          {
            "id": "gpt-4o",
            "name": "GPT-4o",
            "input": ["text", "image"],
            "contextWindow": 128000
          },
          {
            "id": "gpt-4o-mini",
            "name": "GPT-4o Mini",
            "input": ["text", "image"],
            "contextWindow": 128000
          }
        ]
      },
      "anthropic": {
        "api": "anthropic-messages",
        "apiKey": "${ANTHROPIC_API_KEY}",
        "models": [
          { "id": "claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet" }
        ]
      }
    },
    "aliases": {
      "smart": "openai/gpt-4o",
      "fast": "openai/gpt-4o-mini",
      "claude": "anthropic/claude-3-5-sonnet-20241022"
    }
  },

  "agents": {
    "defaults": {
      "model": "smart",
      "fastModel": "fast",
      "thinking": "medium",
      "output": {
        "showToolCalls": "summary"
      },
      "heartbeat": {
        "enabled": true,
        "every": "30m"
      },
      "contextPruning": {
        "enabled": true,
        "softTrimRatio": 0.5,
        "hardClearRatio": 0.7,
        "keepLastAssistants": 3
      }
    },
    "mozi": {
      "main": true,
      "name": "Mozi",
      "systemPrompt": "You are Mozi, a helpful AI assistant.",
      "skills": ["memory"]
    }
  },

  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "dmPolicy": "open",
      "streamMode": "partial",
      "statusReactions": { "enabled": true }
    },
    "localDesktop": {
      "enabled": true,
      "widget": {
        "mode": "auto",
        "uiMode": "text"
      }
    }
  },

  "memory": {
    "backend": "builtin",
    "citations": "auto",
    "persistence": {
      "enabled": true,
      "maxMessages": 12
    }
  },

  "extensions": {
    "enabled": true,
    "load": {
      "paths": ["~/.mozi/extensions"]
    }
  },

  "logging": {
    "level": "info"
  }
}
```

---

## Validation Checklist

Before deploying, verify:

- [ ] Only **one agent** has `main: true`
- [ ] Model alias keys **do not contain `/`**
- [ ] VAD `startThreshold >= endThreshold`
- [ ] VAD `minSpeechMs <= maxSpeechMs`
- [ ] Browser CDP URLs use loopback addresses
- [ ] Browser relay has `authToken` when extension driver is used
- [ ] Environment variables are defined in `.env`
- [ ] Paths use `~` for home directory (auto-expanded)

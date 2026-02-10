---
name: auth-config
description: Configure API keys using mozi auth commands and avoid plain-text keys in config.
---

# Auth Config

Use this skill when users need to configure or debug API keys.

## Rules

1. Store keys in `~/.mozi/.env` via `mozi auth`.
2. Keep config values as env references (`apiKeyEnv`) instead of plain-text `apiKey`.
3. Never print full secret values in chat output.

## Quick Start

```bash
mozi auth set tavily
mozi auth set brave
mozi auth list
```

## Troubleshooting

- If Tavily fails with missing key: run `mozi auth set tavily`.
- If Brave fails with missing key: run `mozi auth set brave`.
- If runtime was already running: restart runtime after key updates.

---
name: web-search
description: Search the web via built-in extension tools and return concise source-backed output.
---

# Web Search

Use this skill for latest information and source-backed lookup.

## When To Use

- "search the web"
- "latest news"
- "look this up"
- "find sources for ..."

## Tool Selection

1. Prefer builtin Tavily tool `web_search` when available.
2. Otherwise use builtin Brave tool `brave_search` when available.
3. If neither tool is available, ask the user to enable extensions:

- `extensions.entries.web-tavily.enabled = true`
- `extensions.entries.brave-search.enabled = true`
- If key is missing, ask user to run:
  - `mozi auth set tavily`
  - `mozi auth set brave`

## Quick Start

```bash
QUERY="Who is Leo Messi?"
```

## Quick Start

Call one of these tools:

- Tavily: `web_search({ query: QUERY })`
- Brave: `brave_search({ query: QUERY })`

Environment variables used by extensions:

- Tavily default key env: `TAVILY_API_KEY`
- Brave default key env: `BRAVE_API_KEY`

## Output Rules

1. Provide a short summary first.
2. Include 3-5 source links for key claims.
3. For time-sensitive questions, include concrete dates.
4. Never expose API keys in output.

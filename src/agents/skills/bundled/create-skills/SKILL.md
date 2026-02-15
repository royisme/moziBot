---
name: create-skills
description: Create a new high-quality SKILL.md from a user request with concise, executable structure.
---

# Create Skills

Use this skill when the user asks to create or refine a skill.

## When To Use

- "create a skill for ..."
- "generate SKILL.md"
- "refactor this skill"
- "make this skill simpler"

## Output Target

Create one folder per skill:

```text
<skills_dir>/<skill-name>/SKILL.md
```

Use kebab-case for `<skill-name>`.

## Required Structure

````markdown
---
name: <skill-name>
description: <one-line purpose>
---

# <Title>

<One sentence on when to use>

## When To Use

- <trigger 1>
- <trigger 2>

## Quick Start

```bash
<short runnable command>
```
````

## Steps

1. <step 1>
2. <step 2>
3. <step 3>

## Output Rules

1. <rule 1>
2. <rule 2>

## Safety

- <secret/scope rule>

```

## Quality Bar

1. Keep it short (prefer one screen).
2. Prefer executable commands over abstract explanation.
3. Include concrete parameter names and env vars.
4. Never include secrets or hardcoded API keys.
5. Avoid duplicated sections and nested complexity.

## Validation Checklist

- Frontmatter exists and `name` matches folder name.
- At least one runnable command example is included.
- Output format is explicit.
- Safety constraints are explicit.

## Refactor Rules (for existing skills)

1. Remove long prose that does not change behavior.
2. Merge duplicate sections.
3. Keep only the minimum commands needed for success.
4. Preserve required constraints and safety notes.
```

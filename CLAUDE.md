This file is the entrypoint for agent work in this repository.
Keep it short, executable, and safe to compress.

Detailed docs live in:
- `devDocs/agent-operating-model.md`
- `devDocs/troubleshooting.md`
- `devDocs/spec/`
- `.claude/rules/workflow.md`
- `.claude/rules/artifacts.md`
- `.claude/rules/troubleshooting.md`
- `.claude/rules/routing.md`
- `HANDOFF.md`

## 1. Source of truth

When you need context, use these sources in order:
- project scripts, dependencies, runtime assumptions -> `package.json`
- feature intent and implementation guidance -> `devDocs/spec/`
- current continuation state -> `HANDOFF.md`
- workflow and artifact rules -> `.claude/rules/`
- long-lived process design -> `devDocs/agent-operating-model.md`
- troubleshooting patterns -> `devDocs/troubleshooting.md`

Do not treat chat history or compressed context as durable truth unless written back into repo files.

## 2. Commands

- package manager: `pnpm`
- script runner: `pnpm run <script>`
- check: `pnpm run check`
- test: `pnpm run test`
- typecheck: `npx tsc --noEmit`

Git hooks should enforce:
- pre-commit -> `pnpm run check`
- pre-push -> `pnpm run test`

## 3. Workflow

- Trivial work: execute directly, validate, summarize.
- Non-trivial work: clarify, plan, execute in steps, review, validate, resolve.
- Do not jump into non-trivial implementation without approved or clearly established repo artifacts.
- For detailed rules, read `.claude/rules/workflow.md` and `.claude/rules/artifacts.md`.

## 4. Validation

Every meaningful change must state:
- what changed
- how it was validated
- validation result
- remaining risk, limitation, or follow-up

Passing validation matters more than claiming completion.

## 5. Compact Instructions

When context is compressed, preserve this information in this order:
1. architecture decisions - never summarize away
2. modified files and key changes
3. current verification status with pass/fail state
4. open TODOs, blockers, and rollback notes
5. tool output details may be collapsed to pass/fail only

Session hygiene:
- use `/clear` when switching to a different task
- use `/compact` between major phases of the same task
- use `/context` proactively in long sessions

## 6. Execution constraints

- Prefer structured MCP tools for large outputs.
- Prefer symbol-aware tools for targeted code edits.
- If blocked, check `devDocs/troubleshooting.md` first.
- If a recurring issue appears more than once, promote it into durable repo guidance, tests, or checks.

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |

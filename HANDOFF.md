# HANDOFF

## Current objective

Reduce subagent lifecycle notification verbosity sent to the user in Telegram/Discord.

### Problem

When a subagent runs, the system sends multiple messages to the user:
1. "accepted" notification (direct delivery)
2. "started" notification (direct delivery)
3. Main agent's summarized reply (via LLM fallback, often verbose with prompt details)
4. "completed" notification (direct delivery)

User wants: brief "subagent launched" + "subagent done/failed" only. Full task details should be available via `/tasks status <runId>`, not pushed to chat.

### Key files

- `src/runtime/host/sessions/subagent-announce.ts` — `announceDetachedRun()`, `buildDetachedRunTriggerMessage()`
- `src/runtime/host/sessions/async-task-delivery.ts` — `deliverGuaranteedLifecycleNotification()`, `buildSimpleAckMessage()`
- `src/runtime/host/sessions/subagent-registry.ts` — `triggerPhaseAnnounce()` controls which phases trigger announcements

---

## Previous completions (this session)

### NO_REPLY leak fix + heartbeat triage (spec: `devDocs/spec/no-reply-leak-fix.md`)

- Fix 1: System-internal turns exempt from lifecycle guard (`execution-flow.ts`)
- Fix 2: Ack delivery retry in reconciliation (`subagent-registry.ts`)
- Fix 4: Lightweight heartbeat triage subagent (`heartbeat.ts`)
- All tests pass, check clean

### /tasks command improvements

- Added `/tasks` to Telegram bot menu (`telegram/plugin.ts`)
- Added `/tasks` to Discord slash commands (`discord/plugin.ts`)
- Added `/tasks clean` subcommand to remove terminal tasks (`tasks-command.ts`, `tasks-control-plane.ts`, `subagent-registry.ts`)
- Added "Clean" button to tasks list UI

### Validation

- `pnpm run check` ✅
- `pnpm run test` ✅ (1781 tests)
- `npx tsc --noEmit` ✅

---

## Previous objectives (older sessions)

### Two-Tier Watchdog + Unified Event Queue (Phases 1-5)

Committed in `d9b44ec`. Spec: `devDocs/spec/watchdog-event-queue-arch.md`

### Contract layer alignment

Five-phase provider/auth/model contract alignment. See git history for details.

---

## Resume checklist

- read `CLAUDE.md`
- read `.claude/rules/workflow.md`
- read this file
- for subagent notification work: read `src/runtime/host/sessions/subagent-announce.ts` and `async-task-delivery.ts`

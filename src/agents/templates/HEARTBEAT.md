---
summary: "Home template for HEARTBEAT.md"
read_when:
  - Bootstrapping a new agent manually
---

# HEARTBEAT.md

# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.

@heartbeat enabled=on
@heartbeat every=30m

# Optional: override prompt for heartbeat turns.

# @heartbeat prompt=Read HEARTBEAT.md and execute only listed tasks. Reply HEARTBEAT_OK when no action is needed.

# Context injected into the heartbeat prompt:

# HEARTBEAT_CONTEXT_BEGIN

# SESSION_LAST_ACTIVITY_MS=1700000000000

# SESSION_LAST_ACTIVITY_ISO=2023-11-14T22:13:20.000Z

# HEARTBEAT_CONTEXT_END

# Use this to decide when to send a check-in (e.g., idle > 8h).

## Rules

- Edit THIS file to manage heartbeat behavior.
- Do NOT create periodic heartbeat loops via schedule_continuation.
- Use reminder_create for durable reminder timers.

## Tasks

- [ ] (example) Check urgent notifications
- [ ] (example) Review today's calendar for upcoming meetings

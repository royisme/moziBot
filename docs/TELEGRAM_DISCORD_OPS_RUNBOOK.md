# Telegram/Discord Ops Runbook

Operational troubleshooting guide for Telegram and Discord channel integrations.

## Quick Reference

| Channel | Text Limit | Media Limit | Rate Limits |
|---------|-------------|--------------|-------------|
| Telegram | 4096 chars | 10MB (photos), 50MB (documents) | 30 msg/sec |
| Discord | 2000 chars per chunk | 8MB (free), 50MB (nitro) | 5-50 req/sec |

## Common Log Keywords

### Connection & Lifecycle

| Keyword | Source | Meaning |
|---------|--------|---------|
| `Telegram bot connected` | `telegram/plugin.ts:285` | Bot successfully connected and polling |
| `Discord bot ready as` | `discord/plugin.ts:489` | Gateway connected, bot authenticated |
| `Telegram polling supervisor stopped with error` | `telegram/plugin.ts:203` | Polling crashed, check recovery status |
| `Discord gateway error` | `discord/plugin.ts:465` | WebSocket error, may auto-reconnect |
| `Recoverable Telegram polling failure; restarting` | `telegram/plugin.ts:320` | Network error, exponential backoff retry |

### Permissions & Access Control

| Keyword | Source | Meaning |
|---------|--------|---------|
| `Telegram message dropped by allowedChats` | `telegram/handlers.ts:40` | Chat ID not in whitelist |
| `Telegram message dropped by dmPolicy=allowlist` | `telegram/handlers.ts:47` | DM sender not in allowlist |
| `Discord DM dropped by dmPolicy=allowlist` | `discord/plugin.ts:857` | DM sender not in allowlist |
| `Discord group message dropped by groupPolicy=allowlist` | `discord/plugin.ts:882` | Group sender not in allowlist |
| `Discord group message dropped by role allowlist` | `discord/plugin.ts:870` | User lacks required role |
| `Discord group message dropped by requireMention=true` | `discord/plugin.ts:897` | Bot not mentioned in group |

### Message Sending

| Keyword | Source | Meaning |
|---------|--------|---------|
| `Telegram outbound send requested` | `telegram/plugin.ts:407` | Outbound message queued |
| `Discord outbound send requested` | (similar pattern) | Outbound message queued |
| `Discord webhook send failed` | `discord/plugin.ts:676` | Webhook HTTP error |
| `Failed to edit Telegram message` | `telegram/send.ts:417` | Message may be too old (48h limit) |
| `Discord attachment skipped` | `discord/plugin.ts:1121` | Media missing buffer/path/url |

### Rate Limiting

| Keyword | Source | Meaning |
|---------|--------|---------|
| `Telegram rate limit, waiting` | `telegram/retry.ts:53` | Hit Flood Wait, automatic retry |
| `Telegram API error, retrying` | `telegram/retry.ts:63` | Retryable API error |

## Failure Scenarios

### 1. Permissions / Allowlist Failures

**Symptom**: Messages silently dropped, no error logged to user.

**Detection**:
```bash
# Search logs for permission drops
grep -E "(dropped by|not allowed)" logs/app.log | grep -E "telegram|discord"
```

**Resolution**:
- Telegram: Check `allowedChats` and `dmPolicy` / `groupPolicy` config
- Discord: Check `dmPolicy`, `groupPolicy`, and `guilds[].allowRoles` config
- For Discord, ensure bot has correct intents: `GatewayIntents.Guilds | GatewayIntents.GuildMessages | GatewayIntents.MessageContent | GatewayIntents.DirectMessages`

### 2. Text Chunking Failures

**Symptom**: Long messages truncated or error on send.

**Detection**:
```bash
# Look for chunk-related errors
grep -E "(chunk|truncat|limit)" logs/app.log | grep -E "telegram|discord"
```

**Resolution**:
- Telegram: Uses `grammy` built-in chunking (4096 char limit)
- Discord: Uses `chunkTextWithMode()` from `src/utils/text-chunk.ts` with `discord` limit of 2000 chars
- For very long messages, ensure content is pre-chunked before sending

**Code Path**:
- Discord: `discord/plugin.ts:535` - `chunkTextWithMode(content, DISCORD_TEXT_LIMIT, "paragraph")`

### 3. Thread Creation Failures

**Symptom**: Cannot create Discord thread or Telegram topic.

**Detection**:
```bash
# Check for thread-related errors
grep -iE "(thread|topic|create)" logs/app.log | grep -E "discord.*error|telegram.*error"
```

**Resolution**:
- Discord: Ensure bot has `Guilds` intent and proper channel permissions (`CREATE_PUBLIC_THREADS`, `CREATE_PRIVATE_THREADS`)
- Telegram: Bot needs `chat_id` and may require `is_forum` flag on supergroup

### 4. Webhook Failures (Discord)

**Symptom**: `Discord webhook send failed: {status}` where status is 4xx/5xx.

**Detection**:
```bash
grep "webhook send failed" logs/app.log
```

**Resolution**:
- Verify webhook URL is valid and not expired
- Check webhook permissions in channel settings
- For 403: Ensure bot has `MANAGE_WEBHOOKS` permission
- For 404: Webhook may have been deleted, regenerate URL

**Code Path**:
- `discord/plugin.ts:615-686` - `sendViaWebhook()`

### 5. URL Media Guardrail Failures

**Symptom**: Media URLs rejected or fail to upload.

**Detection**:
```bash
grep -E "(attachment|media|upload)" logs/app.log | grep -E "failed|error|reject"
```

**Resolution**:
- Telegram: File must be downloaded via Telegram API (`getFile`), not arbitrary URLs
- Discord: URLs in media array are converted to embed links, not direct uploads
- For Discord file uploads: Ensure media has `buffer` or `path` property, not just `url`

**Code Path**:
- Discord: `discord/plugin.ts:1086-1119` - `resolveOutboundFiles()`
- Telegram: `telegram/plugin.ts:177-185` - `getDownloadUrl()`

### 6. Network/Connection Failures

**Symptom**: Bot goes offline or cannot connect.

**Detection**:
```bash
# Telegram connection issues
grep -E "polling|Telegram.*error" logs/app.log | tail -20

# Discord connection issues
grep -E "gateway|Discord.*error" logs/app.log | tail -20
```

**Resolution**:

**Telegram Recoverable Errors** (auto-retry):
- DNS resolution failures (`ENOTFOUND`, `EAI_AGAIN`)
- Timeouts (`ETIMEDOUT`, `ECONNRESET`)
- HTTP 5xx from Telegram servers
- `getUpdates` conflict (another instanceelegram Non-Recover polling)

**Table** (requires restart):
- 401: Invalid bot token
- 403: Bot blocked by user
- 404: Invalid chat/message ID

**Discord Auth Failures**:
- `4004` or "authentication failed": Token invalidated, update `botToken` and restart

**Code Path**:
- Telegram: `src/runtime/adapters/channels/telegram/network-errors.ts`
- Discord: `discord/plugin.ts:969-1003` - auth failure handling

### 7. Status Reaction Failures

**Symptom**: Reactions not appearing on messages.

**Detection**:
```bash
grep -E "status reaction|set reaction" logs/app.log
```

**Resolution**:
- Ensure `statusReactions.enabled: true` in config
- Check emoji values are valid for platform
- Telegram: Bot needs `message_reactions` permission
- Discord: Bot needs `ADD_REACTIONS` permission

## SLO Notes

### Availability Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Telegram connection uptime | > 99.9% | Logged via `Telegram bot connected` / `disconnected` |
| Discord connection uptime | > 99.9% | Logged via `Discord bot ready as` |
| Message delivery success | > 99% | Outbound send without error |

### Observability Cues

- **Connection state**: Check `channel.status` property ("connected", "connecting", "error", "disconnected")
- **Error events**: Plugins emit `error` events via EventEmitter - subscribe in monitoring
- **Rate limit tracking**: Telegram's `retry.ts` logs `retryAfter` for monitoring backpressure

### Health Check Commands

```bash
# Test Telegram bot token
curl "https://api.telegram.org/bot<TOKEN>/getMe"

# Test Discord bot
curl -H "Authorization: Bot <TOKEN>" "https://discord.com/api/v10/users/@me"
```

## Configuration Reference

### Telegram Config Schema

```jsonc
{
  "channels": {
    "telegram": {
      "botToken": "required",
      "allowedChats": ["optional whitelist"],
      "dmPolicy": "open | allowlist",
      "groupPolicy": "open | allowlist",
      "groups": {
        "<chat_id>": {
          "requireMention": true
        }
      },
": {
        "      "pollingtimeoutSeconds": 30,
        "maxRetryTimeMs": 60000,
        "retryInterval": "exponential"
      },
      "statusReactions": {
        "enabled": false,
        "emojis": { ... }
      }
    }
  }
}
```

### Discord Config Schema

```jsonc
{
  "channels": {
    "discord": {
      "botToken": "required",
      "allowedGuilds": ["optional whitelist"],
      "allowedChannels": ["optional whitelist"],
      "dmPolicy": "open | allowlist",
      "groupPolicy": "open | allowlist",
      "allowFrom": ["userid1", "username1"],
      "guilds": {
        "<guild_id>": {
          "allowRoles": ["role_id"],
          "allowFrom": ["userid"],
          "requireMention": false,
          "roleRouting": { ... }
        }
      },
      "statusReactions": {
        "enabled": false
      }
    }
  }
}
```

## Testing Verification

Run channel-specific tests:

```bash
pnpm run test -- --grep "telegram"
pnpm run test -- --grep "discord"
```

Key test files:
- `src/runtime/adapters/channels/telegram/*.test.ts`
- `src/runtime/adapters/channels/discord/*.test.ts`
- `src/utils/text-chunk.test.ts`

# WeChat Channel — Feature Spec (Phase 1: Text-only)

## Goal

Add WeChat (ilink bot) as a first-class channel in mozi, following the same `BaseChannelPlugin`
pattern as Telegram. Phase 1 covers text-only DMs — no CDN media download/upload.

## Source reference

The official OpenClaw WeChat plugin (`@tencent-weixin/openclaw-weixin@1.0.2`) was used as the
authoritative reference for the ilink bot API. Relevant source files are in
`/tmp/openclaw-weixin-src/package/src/` (local copy from `npm pack`).

---

## API Overview

**Backend**: `https://ilinkai.weixin.qq.com` (hardcoded default; overridable via config)

| Endpoint | Usage |
|---|---|
| `POST ilink/bot/getupdates` | Long-poll; server holds ≤35 s. Returns `WeixinMessage[]`. |
| `POST ilink/bot/sendmessage` | Send text (or media) downstream. |
| `POST ilink/bot/sendtyping` | Send typing indicator (`status=1` start, `status=2` cancel). |
| `POST ilink/bot/getconfig` | Fetch `typing_ticket` per user per message. |

### Auth headers (every request)

```
Authorization: Bearer <token>
AuthorizationType: ilink_bot_token
Content-Type: application/json
X-WECHAT-UIN: <random uint32 → decimal → base64>
Content-Length: <byte length of JSON body>
```

### `base_info` payload (every request body)

```json
{ "base_info": { "channel_version": "1.0.2" } }
```

---

## Critical Constraint: `context_token`

Each inbound message includes a `context_token`. **Every outbound reply must echo the same
`context_token` verbatim**, or the server cannot associate the reply with the conversation.

- Stored in-process only (`Map<peerId, contextToken>`), keyed by `peerId` (= `from_user_id`).
- Not persisted. After process restart, the first message from a user repopulates it.
- If `contextToken` is missing when trying to send, log a warning and skip — do not throw.

---

## Long-poll State: `get_updates_buf`

`getupdates` uses an opaque cursor `get_updates_buf`. Rules:
- Send `""` on first request or after reset.
- On response: if `get_updates_buf` is non-empty, save to disk and use for next request.
- Persist path: `<DATA_DIR>/wechat/<token-hash>/get_updates_buf`.
- On client-side timeout (AbortError), return empty response and retry — this is normal.

### Session expiry (`errcode === -14`)

Pause all requests for 30 minutes; log clearly. Do not crash.

---

## Inbound Message Normalization

`WeixinMessage` → `InboundMessage`:

| WeixinMessage field | InboundMessage field |
|---|---|
| `from_user_id` | `peerId`, `senderId` |
| `item_list[TEXT].text_item.text` | `text` |
| `item_list[TEXT].ref_msg` | prepend `[引用: ...]` to `text` |
| `item_list[VOICE].voice_item.text` | `text` (ASR result, if present) |
| `create_time_ms` | `timestamp` |
| `message_id` | `id` |
| `context_token` | stored in `contextTokenStore[peerId]` |
| — | `channel: "wechat"` |
| — | `peerType: "dm"` (ilink only supports DM) |

Phase 1: skip IMAGE, VIDEO, FILE, VOICE-without-text items (log and continue, don't crash).

### Text body extraction priority

1. First `TEXT` item with non-empty `text_item.text`
2. First `VOICE` item with non-empty `voice_item.text` (ASR)
3. Empty string (message silently dropped — no `emitMessage`)

---

## Outbound: Text Send

```
POST ilink/bot/sendmessage
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<peerId>",
    "client_id": "<random id>",
    "message_type": 2,       // BOT
    "message_state": 2,      // FINISH
    "context_token": "<token>",
    "item_list": [
      { "type": 1, "text_item": { "text": "<text>" } }
    ]
  },
  "base_info": { "channel_version": "1.0.2" }
}
```

### Markdown stripping

WeChat does not render markdown. Strip before sending:
- Code fences → keep code content, strip ` ``` ` lines
- `![alt](url)` → remove entirely
- `[text](url)` → `text`
- Table separator rows → remove
- Table rows → strip `|`, join with `  `
- Then apply general markdown stripping (bold `**`, italic `_`, headers `#`, etc.)

### Outbound retry

On network error or non-2xx: retry once after 2 s. Log and give up on second failure.
Never infinite-retry — let the message drop rather than block the event loop.

---

## Typing

- Requires `typing_ticket` fetched via `getconfig` per user per message.
- `getconfig` response: `{ typing_ticket: "<base64>" }`.
- `sendtyping` body: `{ ilink_user_id: "<peerId>", typing_ticket: "<ticket>", status: 1|2 }`.
- Typing keepalive: resend `status=1` every 5 s while processing.
- On `typing_ticket` fetch failure: skip typing silently (degraded, not fatal).

---

## File Structure

```
src/runtime/adapters/channels/wechat/
  index.ts          — re-export WechatPlugin
  plugin.ts         — WechatPlugin extends BaseChannelPlugin
  api.ts            — getUpdates, sendMessage, sendTyping, getConfig (pure HTTP, no framework deps)
  types.ts          — WeixinMessage, GetUpdatesResp, SendMessageReq, etc.
  inbound.ts        — contextTokenStore + weixinMessageToInbound()
  send.ts           — sendText() + markdownToPlainText()
  monitor.ts        — long-poll loop (getUpdates → normalize → emitMessage)
  sync-buf.ts       — persist/load get_updates_buf to DATA_DIR
```

---

## Config Schema

```typescript
export interface WechatPluginConfig {
  /** ilink bot token from QR login */
  token: string;
  /** Optional allowlist of WeChat user IDs (from_user_id values). Empty = allow all. */
  allowFrom?: string[];
  /** Override API base URL. Default: https://ilinkai.weixin.qq.com */
  baseUrl?: string;
  /** Long-poll timeout in seconds. Default: 35 */
  pollingTimeoutSeconds?: number;
}
```

---

## WechatPlugin Class Contract

Extends `BaseChannelPlugin`. Key methods:

| Method | Behaviour |
|---|---|
| `connect()` | Start long-poll supervisor loop. Set status `connecting` → `connected`. |
| `disconnect()` | Abort signal → stop loop → set status `disconnected`. |
| `send(peerId, msg)` | Look up `contextToken[peerId]`. If missing, log warn + return. Strip markdown. POST `sendmessage`. Return `client_id` as message ID. |
| `beginTyping(peerId)` | Fetch `typing_ticket` via `getconfig`. Start 5 s keepalive. Return stop callback. |
| `getCapabilities()` | `{ media: false, polls: false, reactions: false, threads: false, editMessage: false, deleteMessage: false, implicitCurrentTarget: true, maxTextLength: 4000, supportedActions: ["send_text", "reply"] }` |

### Long-poll supervisor (same pattern as TelegramPlugin)

```
while (!aborted):
  try:
    call getUpdates (35 s timeout)
    on AbortError: retry immediately (normal timeout)
    on errcode -14: pauseSession 30 min
    on other error: consecutiveFailures++; backoff 2 s / 30 s after 3 failures
    on success:
      save get_updates_buf
      for each msg: emitMessage(weixinMessageToInbound(msg))
  catch: same backoff
```

---

## allowFrom Filtering

If `config.allowFrom` is non-empty, drop messages where `from_user_id` is not in the list.
Log at `info` level: `"wechat DM dropped by allowFrom"`.

---

## Error Handling

| Situation | Handling |
|---|---|
| `contextToken` missing at send time | `logger.warn` + return `""` (no throw) |
| `typing_ticket` fetch failure | skip typing, continue |
| `sendmessage` failure after 1 retry | `logger.error` + throw (caller handles) |
| Session expired (errcode -14) | pause 30 min, continue loop |
| 3 consecutive `getUpdates` failures | backoff 30 s, reset counter |
| `get_updates_buf` file unreadable | start from `""` (no crash) |

---

## What is NOT in Phase 1

- CDN media download/decrypt (AES-128-ECB) for inbound images/files/videos
- Outbound media upload (CDN upload + AES encrypt)
- Voice transcoding (silk → wav)
- Group chat support (ilink is DM-only for now)
- QR login flow (token is set manually in config)
- Status reactions

---

## Validation

```bash
pnpm run check    # lint + format
npx tsc --noEmit  # zero errors
pnpm run test     # all tests pass (add unit tests for inbound normalization + send)
```

Manual smoke test (requires a valid ilink bot token):
1. Set `config.wechat.token` in local config
2. Start mozi, send a WeChat message to the bot
3. Verify mozi replies without "contextToken missing" warnings
4. Verify long-poll resumes correctly after process restart (get_updates_buf restored)

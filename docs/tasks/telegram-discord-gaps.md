# Telegram/Discord 实现差距分析

> 对比参考: `~/software/myproject/ts/openclaw_source_github`
> 基于 2026-02-27 调研结果

## 概要

moziBot 的 Telegram/Discord 适配器实现了基本的消息收发，但与 openclaw 参考实现相比，缺少多项生产级功能。本文档按严重程度列出所有差距，并提供实现所需的上下文。

---

## Batch A: 基础修复 (中等复杂度)

### A1. replyToId 未接入发送

**问题**: `OutboundMessage.replyToId` 字段存在但从未传递给 Telegram API。
**影响**: 回复线程断裂，agent 的回复不会显示为对用户消息的 reply。

**moziBot 文件**:
- `src/runtime/adapters/channels/telegram/send.ts` — `sendMessage()` 和 `sendTextWithChunking()` 不传 `reply_parameters`
- `src/runtime/adapters/channels/types.ts:21` — `OutboundMessage.replyToId` 定义存在

**openclaw 参考**:
- `src/telegram/send.ts:278-288` — `reply_parameters: { message_id, quote }` 传入每个 send 调用
- `buildTelegramThreadReplyParams()` 构建回复参数

**修复方案**:
```typescript
// 在 sendMessage 中，构建 baseOptions 时加入:
const reply_parameters = message.replyToId
  ? { message_id: Number(message.replyToId) }
  : undefined;
// 传给每个 bot.api.send* 调用
```

### A2. Inbound replyToId 未填充

**问题**: Telegram 和 Discord 的 inbound handler 都不提取 `replyToId`。
**影响**: Agent 无法知道用户在回复哪条消息。

**moziBot 文件**:
- `src/runtime/adapters/channels/telegram/handlers.ts:81-91` — inbound 对象不设 `replyToId`
- `src/runtime/adapters/channels/discord/plugin.ts:461-473` — 同上

**修复方案**:
```typescript
// Telegram handler:
replyToId: msg.reply_to_message?.message_id?.toString(),

// Discord handler:
replyToId: msg.reference?.messageId,
```

### A3. Caption 超长切分

**问题**: Telegram caption 限制 1024 字符，moziBot 直接传入无长度检查。
**影响**: 长文本 + 媒体的消息会收到 Telegram API 400 错误。

**moziBot 文件**:
- `src/runtime/adapters/channels/telegram/send.ts:52-54` — `caption` 直接赋值

**openclaw 参考**:
- `src/telegram/caption.ts` — `splitTelegramCaption()` 函数
- 逻辑: caption > 1024 时，媒体发送不带 caption，然后跟一条文本消息

**修复方案**:
1. 新建 `src/runtime/adapters/channels/telegram/caption.ts`
2. 当 caption 长度 > 1024 时: 媒体发送带空 caption，之后发送文本消息
3. 保持 HTML 格式在切分时的完整性

### A4. URL 媒体未下载

**问题**: `MediaAttachment.url` 存在但从未 fetch — 只有 `buffer` 被发送。
**影响**: 通过 URL 引用的媒体被静默忽略。

**moziBot 文件**:
- `src/runtime/adapters/channels/telegram/send.ts:48-50` — `if (!media.buffer)` 直接跳过
- `src/runtime/adapters/channels/types.ts` — `MediaAttachment.url` 字段

**openclaw 参考**:
- `src/telegram/send.ts:560-571` — `loadWebMedia(mediaUrl, ...)` 下载 URL 到 buffer

**修复方案**:
1. 当 `media.url` 存在且 `media.buffer` 不存在时，fetch URL 到 buffer
2. 加入大小限制 (建议 50MB)
3. 加入超时 (建议 30s)

### A5. Inbound threadId 未填充 (Discord)

**问题**: Discord 消息的 `thread_id` 未被提取到 `InboundMessage.threadId`。
**影响**: 线程感知路由不可用。

**moziBot 文件**:
- `src/runtime/adapters/channels/discord/plugin.ts:461-473` — `handleMessage` 不设 `threadId`

**修复方案**:
```typescript
threadId: msg.channelId !== msg.channel?.id ? msg.channelId : undefined,
// 或直接用 Discord.js 的 thread 检测
```

### A6. OutboundMessage.silent 未接入

**问题**: `OutboundMessage.silent` 存在但未传给 Telegram `disable_notification`。

**moziBot 文件**: `send.ts` — 所有 send 调用不传 `disable_notification`

**修复**: 在 `baseOptions` 中加入 `disable_notification: message.silent ?? false`

---

## Batch B: 生产加固 (高复杂度)

### B1. API 重试逻辑

**问题**: 无重试。网络抖动时消息静默丢失。

**openclaw 参考**:
- `src/telegram/infra/retry-policy.ts` — `createTelegramRetryRunner()`
- `src/telegram/send.ts:344-432` — 每个 API 调用包装在重试 runner 中
- `isRecoverableTelegramNetworkError()` 分类可恢复错误 (5xx, 网络超时)

**实现方案**:
1. 新建 `src/runtime/adapters/channels/telegram/retry.ts`
2. 实现指数退避重试 (3 次, 1s/2s/4s)
3. 只对可恢复错误重试 (5xx, ETIMEDOUT, ECONNRESET)
4. 429 错误读取 `retry_after` 头

### B2. API 限流 (Throttler)

**问题**: 高并发下触发 Telegram 429 限流。

**openclaw 参考**:
- `src/telegram/bot.ts:145` — `bot.api.config.use(apiThrottler())`
- 使用 grammy 的 `@grammyjs/transformer-throttler` 插件

**实现方案**:
```bash
pnpm install @grammyjs/transformer-throttler
```
```typescript
import { apiThrottler } from "@grammyjs/transformer-throttler";
bot.api.config.use(apiThrottler());
```

### B3. Media Group 聚合

**问题**: 一个相册的 N 张图触发 N 次 agent 响应。

**openclaw 参考**:
- `src/telegram/bot-handlers.ts` — `createInboundDebouncer` + `media_group_id` 聚合
- 窗口时间: ~500ms，同 `media_group_id` 的消息合并为一条

**实现方案**:
1. 新建 `src/runtime/adapters/channels/telegram/debouncer.ts`
2. 收到带 `media_group_id` 的消息时，等待 500ms 收集同组消息
3. 合并为单条 `InboundMessage`，`media` 数组包含所有图片

### B4. Update 去重 / 安全水位

**问题**: 重启后可能重放已处理的消息。

**openclaw 参考**:
- `src/telegram/bot.ts:151-218` — `createTelegramUpdateDedupe()`
- `pendingUpdateIds` Set + `maybePersistSafeWatermark` 机制

**实现方案**:
1. 持久化最后处理的 `update_id`
2. 启动时从持久化恢复，跳过已处理的 update
3. 使用 `pendingUpdateIds` 跟踪正在处理的 update

### B5. 论坛/话题路由

**问题**: forum supergroup 消息全部发到 General topic。

**openclaw 参考**:
- `src/telegram/send.ts:260-290` — `buildTelegramThreadReplyParams()`
- `src/telegram/send.ts:393-418` — `withTelegramThreadFallback()`

**实现方案**:
1. 提取 inbound `message_thread_id`
2. 在 outbound 时传入 `message_thread_id`
3. 加入 fallback: thread 不存在时回退到无 thread

---

## Batch F: UX 增强 (中等复杂度)

### F1. Streaming Draft (实时编辑)

**问题**: 用户等到 LLM 完整输出才能看到回复。

**openclaw 参考**:
- `src/telegram/draft-stream.ts` — `createTelegramDraftStream()`
- 发送初始消息 → 随 LLM 输出增长不断 editMessage → 完成
- 节流编辑避免限流，`minInitialChars` 延迟首次发送

**实现方案**:
1. 新建 `src/runtime/adapters/channels/telegram/draft-stream.ts`
2. 与 agent 的 streaming 回调对接
3. 实现编辑节流 (建议 1-2s 间隔)

### F2. Discord Edit/Delete Message

**问题**: 无法编辑或删除已发消息。

**openclaw 参考**:
- `src/discord/send.messages.ts` — `editMessageDiscord()`, `deleteMessageDiscord()`

**实现方案**: 在 `DiscordPlugin` 上实现 `editMessage(messageId, newContent)` 和 `deleteMessage(messageId)`

---

## 非重要项 (Nice-to-have, 记录备查)

| 功能 | openclaw 文件 | 说明 |
|---|---|---|
| Sticker 收发 | `bot-handlers.ts`, `send.ts` | 贴纸消息 |
| Poll 收发 | `send.ts:sendPollTelegram` | 投票 |
| Forum topic 创建 | `send.ts:createForumTopicTelegram` | 创建新话题 |
| Link preview 配置 | `send.ts` | `link_preview_options` |
| Edited message 处理 | `bot.ts:86-113` | 编辑后的消息 |
| Channel post 处理 | `bot.ts` | 频道消息 |
| Reaction 接收 | `bot.ts:81-85` | 用户 reaction |
| 代理/超时配置 | `bot.ts:125-142` | proxy, custom fetch |
| Webhook 生产服务器 | `webhook.ts` | 完整 webhook 服务 |
| PluralKit 支持 | `pluralkit.ts` | Discord PK 集成 |
| Discord thread 创建 | `send.messages.ts` | 创建线程 |
| Discord pin/unpin | `send.messages.ts` | 置顶消息 |
| Discord webhook send | `send.outbound.ts` | webhook 消息 |
| Discord voice message | `send.outbound.ts` | OGG/Opus 语音 |
| Discord 完整 reaction API | `send.reactions.ts` | emoji 管理 |
| Discord guild moderation | `send.guild.ts` | 管理操作 |
| Discord message search | `send.messages.ts` | 消息搜索 |

---

## 文件路径快速参考

| 类型 | moziBot | openclaw |
|---|---|---|
| TG send | `src/runtime/adapters/channels/telegram/send.ts` | `src/telegram/send.ts` |
| TG plugin | `src/runtime/adapters/channels/telegram/plugin.ts` | `src/telegram/bot.ts` |
| TG handlers | `src/runtime/adapters/channels/telegram/handlers.ts` | `src/telegram/bot-handlers.ts` |
| TG render | `src/runtime/adapters/channels/telegram/render.ts` | `src/telegram/format.ts` |
| TG typing | `src/runtime/adapters/channels/telegram/typing.ts` | `src/telegram/sendchataction-401-backoff.ts` |
| Discord plugin | `src/runtime/adapters/channels/discord/plugin.ts` | `src/discord/monitor/provider.ts` |
| Discord send | `src/runtime/adapters/channels/discord/plugin.ts` (inline) | `src/discord/send.outbound.ts` |
| 共享类型 | `src/runtime/adapters/channels/types.ts` | (分散在各模块) |

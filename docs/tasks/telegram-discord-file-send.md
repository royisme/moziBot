# Issue: Telegram/Discord 文件发送功能不完整

## 问题

moziBot 的 Telegram 和 Discord 适配器不支持发送多种媒体类型，只支持基本的 text/photo/document。

## 目标

参考 openclaw_source_github 的实现，补充完整的文件发送支持。

## 参考实现

### Openclaw Telegram 发送逻辑
关键文件: `~/software/myproject/ts/openclaw_source_github/src/telegram/send.ts`

根据 media kind 自动选择发送方法:
- `image` → `sendPhoto`
- `video` → `sendVideo` 或 `sendVideoNote` (如果 isVideoNote)
- `audio` → `sendAudio` 或 `sendVoice` (如果 asVoice)
- `animation/gif` → `sendAnimation`
- 其他 → `sendDocument`

还支持:
- `asVoice`: 把 audio 发送成 voice message
- `asVideoNote`: 把 video 发送成 video note

### moziBot 现状

#### Telegram (src/runtime/adapters/channels/telegram/send.ts)
当前只处理:
- `photo` → sendPhoto
- 其他 → sendDocument

缺少:
- video
- audio  
- voice
- animation/gif
- video note

#### Discord (src/runtime/adapters/channels/discord/plugin.ts)
当前使用 `resolveOutboundFiles` 和 Carbon 的 `serializePayload`，看起来已有基础支持但需要验证:
- 是否支持所有媒体类型
- 文件大小处理
- URL 附件 vs 文件上传

## 实现要求

### 1. Telegram 增强

修改 `src/runtime/adapters/channels/telegram/send.ts`:

1. 扩展 media type 判断逻辑，根据 `media.type` 选择正确的grammy API:
   - `video` → `bot.api.sendVideo()`
   - `audio` → `bot.api.sendAudio()` 或 `bot.api.sendVoice()`
   - `animation` → `bot.api.sendAnimation()`
   - `video_note` → `bot.api.sendVideoNote()`

2. 支持额外的发送选项 (如果 OutboundMessage 有):
   - `asVoice?: boolean` - 把 audio 发送成 voice
   - `asVideoNote?: boolean` - 把 video 发送成 video note

3. 参考 openclaw 的错误处理和重试逻辑

### 2. Discord 验证

检查 `src/runtime/adapters/channels/discord/plugin.ts`:
- 确认 `resolveOutboundFiles` 是否正确处理所有类型
- 测试大文件上传
- 测试 URL 附件

### 3. 测试

添加测试覆盖:
- 各媒体类型发送
- 错误处理
- 大文件场景

## 验收标准

- Telegram: 能发送 photo, video, audio, voice, animation, document
- Discord: 能发送各类媒体（验证现状）
- 测试通过

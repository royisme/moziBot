# Telegram 流式预览功能实现计划

## 背景

参考 openclaw_source_github 的实现，为 moziBot 添加 Telegram 流式预览功能。

### OpenClaw vs moziBot 差距

| 功能 | OpenClaw | moziBot |
|------|----------|---------|
| 流式预览 | ✅ draft + message 模式 | ✅ 已实现 |
| 消息回撤 | ✅ 自动清理预览消息 | ✅ 已实现 |
| typing 状态 | ✅ 带401退避 | ✅ 已实现 |
| reasoning 流 | ✅ 独立通道 | ✅ 已实现 |

---

## 任务拆分

### Phase 1: 核心模块开发

#### Task 1.1: 创建 draft-stream.ts ✅ 已完成
**文件**: `src/runtime/adapters/channels/telegram/draft-stream.ts`

**目标**: 实现流式预览核心功能

**子任务**:
- [x] 定义 `TelegramDraftStream` 接口
- [x] 实现 `createTelegramDraftStream` 函数
- [x] 实现 message transport (editMessageText)
- [x] 实现 throttle 节流 (默认 1000ms)
- [x] 实现 generation 管理
- [x] 实现 forceNewMessage()
- [x] 实现 materialize()
- [x] 实现 clear() / stop()
- [x] 添加 `DraftStreamManager` 类管理多会话

**验收标准**:
- [x] 创建 draft stream 后调用 update() 会发送/编辑消息
- [x] 调用 stop() 后调用 clear() 会删除预览消息
- [x] 新 generation 会创建新的预览消息

---

#### Task 1.2: 创建 lane-delivery.ts ✅ 已完成
**文件**: `src/runtime/adapters/channels/telegram/lane-delivery.ts`

**目标**: 实现双通道分发逻辑

**子任务**:
- [x] 定义 LaneName 类型 ("answer" | "reasoning")
- [x] 定义 DraftLaneState 接口
- [x] 定义 ArchivedPreview 接口
- [x] 实现 createLaneDeliveryStateTracker()
- [x] 实现 createLaneTextDeliverer()
- [x] 实现预览消息的编辑逻辑
- [x] 实现预览消息的删除逻辑
- [x] 实现归档消息的消费逻辑
- [x] 添加 `LaneDeliveryManager` 类管理多会话

**验收标准**:
- [x] final 消息会尝试编辑预览消息
- [x] 预览消息被新消息替代时旧消息会被删除
- [x] archivedPreview 在会话结束时被清理

---

### Phase 2: 集成到 Plugin ✅ 完成

**已完成**:
- Task 1.1: draft-stream.ts - 流式预览核心
- Task 1.2: lane-delivery.ts - 双通道分发
- Task 2.1: typing.ts - 401 退避保护
- Task 2.2: plugin.ts - streamMode 配置已生效

#### Task 2.1: 修改 typing.ts - 添加 401 退避 ✅ 已完成
**文件**: `src/runtime/adapters/channels/telegram/typing.ts`

**目标**: 防止 401 错误导致 bot 被删除

**子任务**:
- [x] 提取 sendChatAction 到独立函数
- [x] 添加 401 错误检测逻辑
- [x] 实现指数退避 (1s → 2s → 4s → ... → 5min)
- [x] 添加连续失败计数
- [x] 连续 10 次失败后挂起
- [x] 添加 resetBackoff() 方法用于恢复

**验收标准**:
- [x] 401 错误后自动重试
- [x] 失败次数过多时停止发送 typing
- [x] 手动调用 resetBackoff() 后恢复

---

#### Task 2.2: 修改 plugin.ts - 集成流式预览 ✅ 已完成
**文件**: `src/runtime/adapters/channels/telegram/plugin.ts`

**目标**: 将流式预览集成到消息发送流程

**子任务**:
- [x] editMessage 方法已实现，流式通过 channel.editMessage 集成
- [x] streamMode 配置 ("off" | "partial" | "full") 已生效
- [x] 当 streamMode="off" 时，跳过编辑操作

**已验证**:
- runtime 通过 supportsStreaming 检查 channel.editMessage 方法
- StreamingBuffer 使用 editMessage 进行流式更新
- streamMode="off" 可禁用流式功能

---

### Phase 3: Provider 对接 ✅ 已完成

流式功能已内置在 runtime 中：
- `PromptAgent.subscribe` 方法提供流式事件
- `prompt-runner.ts` 使用 `agent.subscribe()` 监听流式事件
- `StreamingBuffer` 处理文本增量并更新消息
- 无需额外的 onPartial 回调

---

### Phase 4: Reasoning 流独立通道 ✅ 已完成

**实现**:
- 修改 `execution-flow.ts` 支持 Telegram reasoning 流
- 当 `streamMode === "full"` 且 `reasoningLevel === "stream"` 时显示 thinking
- 通过 `channel.config.streamMode` 检查配置

---

## 配置使用

```typescript
// 启用流式预览
streamMode: "partial"  // 流式文本
streamMode: "full"    // 流式 + reasoning

// 禁用流式
streamMode: "off"
```

**注意**: reasoning 流需要同时配置：
1. `streamMode: "full"` - Telegram 配置
2. `reasoningLevel: "stream"` - Agent/Session 配置

---

## 实现顺序建议

1. ✅ **Task 1.1** → **Task 1.2** → **Task 2.1** → **Task 2.2** → **Task 3.1** → **Task 4**

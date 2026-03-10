# Implementation Guide: Detached Subagent Status Visibility

## 总体思路
复用现有 detached run 基础设施，在 `DetachedRunRegistry` 上补足 phase 级通知去重元数据，并通过现有 `MessageHandler.handleInternalMessage()` 向 parent session 发送轻量生命周期提示。CLI 侧直接读取同一份 registry 数据，提供 `subagent list` 与 `subagent status <runId>` 两个只读查询入口。

## 涉及文件

### 主要实现文件
- `src/runtime/host/sessions/subagent-registry.ts`
- `src/runtime/host/sessions/subagent-announce.ts`
- `src/runtime/subagent-registry.ts`
- `src/runtime/host/message-handler.ts`
- `src/cli/commands/acp.ts` 或现有 CLI command 注册入口
- 新增 `src/cli/commands/subagent-list.ts`
- 新增 `src/cli/commands/subagent-status.ts`
- 对应测试文件（runtime / host / cli）

### 参考文件
- `src/cli/commands/acp-status.ts`：已有单对象状态查询命令格式
- `src/runtime/host/sessions/subagent-registry.integration.test.ts`：registry 持久化与 announce 测试模式
- `docs/spec/acp-detached-runtime-upgrade.md`：detached task registry 唯一事实来源原则

## 数据模型调整
在 `DetachedRunRecord` 上补充 phase announce 去重元数据，建议保持最小增量：
- 为 phase 级通知增加按 run 持久化的去重字段，例如 `announcedPhases` 或等价布尔集合。
- phase 集合至少覆盖：`accepted`、`started`、`streaming`、`terminal`。
- 继续保留现有 terminal 相关字段；若现有 `announced` 仅表示 terminal announce 成功，可将其视作 `terminal` 的兼容位，但实现上需保证语义清晰且可恢复。

关键要求：
- 去重字段必须持久化到 `subagent-runs.json`，这样 host 重启后不会重复发送 phase 提示。
- `streaming` 只记录首次进入，不跟踪流式次数。

## Runtime 流程改造

### 1. accepted
- `spawnSubAgent(...)` / `DetachedRunRegistry.register(...)` 成功后，触发 accepted phase announce。
- phase announce 成功后写入 registry 去重元数据；失败则保留可重试状态，但不要影响 run 本身注册成功。

### 2. started
- 现有 `markStarted(runId)` 是最佳接入点。
- 在状态从 `accepted` 进入 `started` 时，触发 started phase announce，并做每 run 每 phase 去重。

### 3. streaming
- 在 detached subagent 首次收到可见流式内容时调用 registry 的 streaming 标记入口。
- `src/runtime/subagent-registry.ts` 当前已经在 host detached runtime 中区分 `onAccepted` 与 `onTerminal`；需要再补一个首次流式事件回调或等效 wiring。
- `streaming` phase 不要求保存完整输出，只需表示“用户现在知道这个 run 已经开始产出内容”。

### 4. terminal
- 终态仍由 `setTerminal(...)` 汇聚。
- 终态通知继续通过现有 detached run result announce 路径输出自然语言总结。
- terminal phase 也需纳入 per-run per-phase dedupe，避免重试或重复 setTerminal 导致重复终态提示。

## Announce 设计
建议在 `src/runtime/host/sessions/subagent-announce.ts` 中区分两类能力：
1. phase 提示：简短状态消息，用于 accepted / started / streaming / terminal lifecycle visibility。
2. terminal result announce：现有自然语言总结触发器，用于完成/失败结果回传。

phase 文案要求：
- 简短、用户向、不暴露 `sessionKey` 等内部标识。
- 可包含 `runId` 的短引用，便于用户后续执行 `subagent status <runId>`。
- `streaming` 文案强调“已有进展”，但不承诺最终成功。

## CLI 设计

### `subagent list`
输出字段建议至少包含：
- `runId`
- `status`
- `label` 或 `task` 摘要
- `createdAt`
- `startedAt`
- `endedAt`
- `parentKey`（如人类输出过长可只在 JSON 中保留）

行为约束：
- 仅列出 `kind = "subagent"`。
- 默认按 `createdAt desc` 排序，沿用 registry 现有排序行为。
- 当没有记录时输出明确空状态，而不是静默成功。

### `subagent status <runId>`
输出字段建议至少包含：
- `runId`
- `status`
- `task` / `label`
- `cleanup`
- `timeoutSeconds`
- `createdAt` / `startedAt` / `endedAt`
- `result` 摘要
- `error`
- 已通知 phase 摘要

错误处理：
- `runId` 不存在时退出非零并提示未找到。
- 若记录存在但 `kind !== "subagent"`，按未找到或类型不匹配处理，避免把 ACP 记录暴露到 subagent CLI。

## 测试建议
- registry 单测/集成测试：验证 accepted / started / streaming / terminal 的去重与持久化恢复。
- host/session 集成测试：验证 detached subagent run 首次流式输出会触发一次 streaming phase，后续 delta 不重复提示。
- CLI 测试：参考 `acp-status.ts` 的输出模式，覆盖 list/status 的人类输出和错误分支。

## 不做事项
- 不新增 `subagent abort` 命令。
- 不把 ACP run 纳入 `subagent list` / `subagent status` 输出。
- 不为了 CLI 查询新增平行缓存或服务层；直接复用 registry 即可。

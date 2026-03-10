# Task 01: Detached run lifecycle visibility in runtime

## 目标
让 detached subagent run 在 accepted、started、首次 streaming、terminal 四个阶段对父会话可见，并保证每个 run 每个 phase 最多提示一次。

## 范围文件
- `src/runtime/host/sessions/subagent-registry.ts`
- `src/runtime/host/sessions/subagent-announce.ts`
- `src/runtime/subagent-registry.ts`
- `src/runtime/host/message-handler.ts`
- 对应 runtime / host 测试文件

## 实现要点
- 在 `DetachedRunRecord` 上补充 phase 去重所需的持久化元数据，并保证 restore / persist / reconcile 兼容旧记录。
- 以 `DetachedRunRegistry` 为唯一入口管理 accepted / started / streaming / terminal phase 的标记与去重，不允许在调用方散落维护独立布尔状态。
- `accepted` 在 run 注册成功后触发；`started` 复用 `markStarted`；`streaming` 在首次可见输出到来时触发且只触发一次；`terminal` 与现有结果 announce 共存。
- 轻量生命周期提示通过 parent session 内部消息发送，文案简短，不暴露内部 sessionKey；终态自然语言总结继续沿用现有 detached result announce 路径。
- 失败的 phase announce 不应破坏 run 状态推进，但需要保留后续避免重复的正确语义；至少保证成功发送后不会重复。

## 验收标准
1. detached subagent run 在 accepted、started、首次 streaming、terminal 时，父会话最多各收到一次对应提示。
2. 多次 `text_delta` 或重复状态推进不会导致重复 `streaming` / `started` / `terminal` 提示。
3. host 重启后已成功记录的 phase 去重状态可恢复，不会重复发送历史 phase 提示。
4. 现有 terminal result announce、cleanup、reconcile 逻辑继续可用。
5. 测试命令：`pnpm run test`

## 注意事项
- `DetachedRunRegistry` 仍是 sole source of truth，不新增 phase cache。
- `streaming` announced only once 是本任务的硬约束。
- 不实现 abort 命令，只处理已有终态中的 `aborted` 展示与通知。

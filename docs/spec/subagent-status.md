# Spec: Detached Subagent Status Visibility

## 背景
当前 detached subagent run 已由 `DetachedRunRegistry` 持久化，但用户只能在 terminal announce 时被动获知结果，无法主动查看有哪些运行中的 subagent，也无法按 `runId` 查询单个任务状态。与此同时，runtime 已存在 accepted / started / streaming / terminal 等生命周期阶段，但对用户可见的通知仍偏少，且缺少统一的去重约束。

## 目标
为 detached subagent run 提供轻量、可查询的状态可见性：

1. 在 run 被接受、开始执行、首次产出流式内容、以及进入终态时，对父会话提供生命周期提示。
2. 每个 run 的每个 phase 最多通知一次；`streaming` 只在首次进入时通知一次。
3. 提供 CLI 查询入口：`subagent list` 与 `subagent status <runId>`。
4. `DetachedRunRegistry` 继续作为 detached run 状态的唯一事实来源，不新增第二套状态存储。

## 非目标
- 不实现 `subagent abort` 或任何中止命令，除非完整的中止能力已先落地。
- 不把 detached run 状态拆分到新的 registry、cache 或 CLI 专用快照文件。
- 不为普通前台同步 subagent run 增加额外状态通道。

## 用户价值
- 用户能在 detached run 刚被接受后立即获得确认，而不是只看到最终结果。
- 用户能区分“已排队 / 已启动 / 已有输出 / 已结束”等阶段，降低是否卡住的不确定性。
- 用户可以通过 CLI 主动检查所有 detached subagent run，或精确检查单个 `runId` 的当前状态与摘要信息。

## 功能范围

### 1. 生命周期通知
对 detached subagent run 增加以下对外可见 phase：
- `accepted`：registry 注册成功，run 已被宿主接受。
- `started`：宿主已开始实际执行 run。
- `streaming`：首次收到可见流式输出后触发，仅一次。
- `terminal`：`completed` / `failed` / `aborted` / `timeout` 之一。

通知策略：
- 以 parent session 为目标发送轻量内部提示。
- 终态仍保留现有结果 announce 能力，但需与 phase dedupe 共存。
- phase 通知必须按 run 维度去重，避免重复刷屏。

### 2. CLI 查询
新增：
- `subagent list`：列出当前 registry 中的 detached subagent runs，支持以人类可读格式输出，并保留 JSON 输出扩展位。
- `subagent status <runId>`：展示单个 detached subagent run 的生命周期状态、时间戳、任务摘要、错误/结果摘要。

CLI 仅查询 `kind = "subagent"` 的记录；ACP detached run 继续通过 ACP 专用命令观察。

## 关键约束
- `DetachedRunRegistry` 是 run 状态、时间戳、终态结果、announce/phase 去重元数据的唯一来源。
- 生命周期 phase 的状态推进必须与现有 `status` 字段兼容，不能破坏已有 terminal 行为与重启补偿逻辑。
- CLI 读取持久化 registry 时，应与运行中 host 使用同一数据模型，避免展示口径分叉。
- 通知文案以“简短、状态导向”为主，不暴露实现细节；终态自然语言总结仍沿用现有 announce 路径。

## 成功标准
- detached subagent run 在 accepted / started / 首次 streaming / terminal 时，父会话最多各收到一次对应提示。
- `streaming` 即使收到多段 delta，也只提示一次。
- `subagent list` 能列出 detached subagent run 的核心字段与状态。
- `subagent status <runId>` 能在 run 存在时返回详情，在 run 不存在时给出明确错误。
- 现有 ACP detached runtime 查询、subagent terminal announce、registry reconcile 语义不回归。

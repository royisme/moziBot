# Spec: Agent Job Runtime（In-Memory 持续执行任务与主动回访）

## 背景

当前 moziBot 的主执行模型仍以“单条 inbound message 驱动一次 prompt 执行”为中心。

这带来的直接表现是：

- agent 可以流式输出，但输出生命周期基本绑定当前消息处理流
- tool call 只是当前 turn 内部阶段，不会自然提升为长期任务
- continuation 更像同 session 的续跑，而不是独立后台任务
- reminders 能主动唤起 runtime，但本质仍是生成一条新的 inbound 消息
- tasks 表已有存储层，但尚未形成“创建 → 调度 → 执行 → 状态跟踪 → 完成后主动投递”的闭环

相较之下，OpenClaw 更接近“run/job 驱动”的 agent runtime：

- agent run 有独立 `runId`
- run 生命周期可观察、可等待、可缓存终态
- cron/gateway 可直接驱动 agent run，而非必须从聊天消息进入
- run 完成后可在当前 turn 之外主动投递结果

本 spec 的目标不是机械复制 OpenClaw 实现，而是在 mozi 现有 runtime 基础上补齐“持续执行任务 / 主动回访”能力。

---

## 核心设计决策

### 决策 1：核心只做 In-Memory Job Runtime

本方案明确**废弃内建任务持久化**的思路。

核心 runtime 只负责：

- 在进程内创建和维护 job
- 跟踪 job 生命周期
- 允许外部等待 job 完成
- 在 job 完成后主动回访用户

核心 runtime **不负责**：

- 将 job 状态持久化到数据库
- 建立任务历史表
- 提供长期任务管理系统
- 承载 kanban / issue / 项目管理语义

### 决策 2：持久化不是 runtime 核心职责

这里的“任务”分成两类：

#### A. Runtime Job

表示 agent 当前正在运行或刚结束的一段执行过程。

特点：

- 短生命周期
- 强依赖进程内状态
- 关注执行态、等待态、投递态
- 适合纯内存管理

#### B. Durable Task Artifact

表示真正需要长期保留的产物与记录。

例如：

- specs
- docs
- git 提交历史
- 计划文档
- issue / kanban card
- 操作日志或人工总结

这些不应由 Agent Job Runtime 内建持久化，而应依赖现有载体或未来插件。

### 决策 3：持久化能力改为未来插件扩展

如果未来需要：

- kanban
- issue 跟踪
- backlog
- 长期任务记录
- 项目协作视图

应设计为**外部插件**，基于 job lifecycle 事件来实现，而不是放进 runtime 核心。

也就是说：

- 核心 runtime 负责“执行”
- 插件负责“记录”

---

## 目标

### 核心目标

为 mozi 增加一套最小可行的 Agent Job Runtime，使系统具备以下能力：

1. 将一次 agent 长任务抽象为独立 `AgentJob`
2. 为 `AgentJob` 建立显式生命周期与内存态状态存储
3. 支持任务由聊天消息之外的入口创建与驱动
4. 支持任务完成后主动向原 channel / peer 回投结果
5. 保持与现有 message-handler / runtime kernel / streaming 体系兼容

### 非目标

当前批次不做：

- 数据库持久化 job 状态
- crash recovery 后恢复运行中 job
- 任务历史查询系统
- 内建 kanban / issue / backlog 模型
- 完整复刻 OpenClaw 的全部 gateway / browser / job UI

---

## 问题定义

### 当前系统的问题

#### 1. Prompt run 仍是 turn 内部实现细节

当前 `runPromptWithFallback(...)` 已经具备：

- active run bookkeeping
- abort / timeout
- streaming subscribe
- tool start / tool end 事件
- lifecycle event emit

但它的宿主仍是当前 `execution-flow`，因此系统默认假设：

> 这次 agent run 应在当前 turn 内结束，并在当前 reply dispatch 阶段完成用户可见交付。

#### 2. 工具调用不会自然升级为任务

当前 tool start / tool end 主要用于：

- phase/status 更新
- 流式 UI 表现

但系统没有把“某个工具启动了一个异步任务，需要稍后继续跟进并主动通知用户”建模为一等语义。

#### 3. Continuation 是 session 续跑，不是 background job

`ContinuationRegistry` 解决的是同 session 后续再补几步 prompt 的需求，但不解决：

- 任务实体化
- 独立等待与完成通知
- 脱离当前 turn 的交付

#### 4. 当前持久化思路会把 runtime 设计带偏

如果一开始就把 job 做成数据库对象，会过早引入：

- 表结构设计
- 恢复语义
- 状态对账
- 历史保留策略
- job/task/project 语义耦合

这些都不是当前最急需解决的问题。

当前最急需解决的是：

> agent 能否接住任务、持续执行，并在完成后主动回来汇报结果。

---

## 设计原则

### 1) In-Memory First

AgentJob 是运行时对象，不是持久化对象。

### 2) 先解决编排，再讨论记录

优先建立：

- job registry
- waiter
- lifecycle
- delivery

而不是先做 DB schema。

### 3) 持久化交给外部载体或插件

长期记录依赖：

- git
- specs/docs
- 外部 issue/kanban 插件

而不是核心 runtime 自己维护任务数据库。

### 4) 与现有链路增量集成

尽量复用：

- `runPromptWithFallback(...)`
- `StreamingBuffer`
- `dispatchReply(...)`
- `runtimeKernel.enqueueInbound(...)`

---

## 目标能力模型

### 新增一等实体：AgentJob

建议新增统一运行时实体：

```ts
interface AgentJob {
  id: string;
  sessionKey: string;
  agentId: string;
  channelId: string;
  peerId: string;
  source: "inbound" | "reminder" | "tool" | "api" | "system";
  kind: "followup" | "background" | "scheduled" | "tool_wait";
  prompt: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  parentJobId?: string;
  traceId?: string;
  resultSummary?: string;
  error?: string;
}
```

### 新增一等实体：AgentJobSnapshot

表示已完成 job 的短期缓存快照，用于：

- `waitForAgentJob(...)`
- 避免重复等待
- 提供短期诊断信息

```ts
interface AgentJobSnapshot {
  id: string;
  status: "completed" | "failed" | "cancelled";
  startedAt?: number;
  finishedAt?: number;
  resultSummary?: string;
  error?: string;
  ts: number;
}
```

### 新增一等实体：AgentJobEvent

```ts
interface AgentJobEvent {
  jobId: string;
  runId?: string;
  type:
    | "job_queued"
    | "job_started"
    | "job_waiting"
    | "job_progress"
    | "job_tool_start"
    | "job_tool_end"
    | "job_completed"
    | "job_failed"
    | "job_cancelled"
    | "job_delivery_requested"
    | "job_delivery_succeeded"
    | "job_delivery_failed";
  at: number;
  payload?: Record<string, unknown>;
}
```

### 新增一等能力：waitForAgentJob

核心能力之一是：

```ts
waitForAgentJob({ jobId, timeoutMs, signal? }): Promise<AgentJobSnapshot | null>
```

这使 job 不再只是当前 turn 的内部细节，而成为外部可等待对象。

---

## 方案总览

最小可行架构拆成 5 层：

1. **Job Model Layer**
   - `AgentJob` / `AgentJobSnapshot` / `AgentJobEvent`
2. **Job Registry Layer**
   - 内存态 active jobs、completed snapshots、waiters、TTL cleanup
3. **Job Runner Layer**
   - 驱动 job 执行，桥接到现有 `runPromptWithFallback(...)`
4. **Job Delivery Layer**
   - 任务完成后主动投递结果到 channel
5. **Job Entry Layer**
   - 从 inbound / reminder / tool / api 等入口创建 job

---

## 模块设计

## Phase 1: In-Memory Job Registry

### 新增文件

- `src/runtime/jobs/types.ts`
- `src/runtime/jobs/registry.ts`
- `src/runtime/jobs/events.ts`

### 职责

#### `types.ts`
定义：

- `AgentJob`
- `AgentJobStatus`
- `AgentJobSource`
- `AgentJobKind`
- `AgentJobSnapshot`
- `AgentJobEvent`

#### `registry.ts`
提供最小 in-memory registry：

- `create(job)`
- `get(jobId)`
- `listActiveBySession(sessionKey)`
- `updateStatus(jobId, nextStatus, patch)`
- `complete(jobId, snapshot)`
- `cancel(jobId)`
- `waitForJob(jobId, timeoutMs, signal?)`
- `pruneSnapshots()`

### 内存结构建议

建议维护：

- `activeJobs: Map<string, AgentJob>`
- `completedSnapshots: Map<string, AgentJobSnapshot>`
- `jobWaiters: Map<string, Set<(snapshot) => void>>`
- `jobEvents: Map<string, AgentJobEvent[]>`（只保留短期 ring buffer）

### Snapshot TTL

为了避免无界增长，completed snapshot 采用 TTL 缓存。

例如：

- 默认 10 分钟
- 到期后移除

这与 OpenClaw 的 run cache 思路一致。

### 状态机约束

允许的状态迁移：

- `queued -> running`
- `running -> waiting`
- `running -> completed`
- `running -> failed`
- `running -> cancelled`
- `waiting -> running`
- `waiting -> completed`
- `waiting -> failed`
- `waiting -> cancelled`

禁止非法跳转，如：

- `completed -> running`
- `failed -> waiting`

---

## Phase 2: Job Runner 复用现有 Prompt Runner

### 新增文件

- `src/runtime/jobs/runner.ts`
- `src/runtime/jobs/job-context.ts`

### 职责

将现有：

- `runPromptWithFallback(...)`
- `handleAgentStreamEvent(...)`
- `StreamingBuffer`
- `emitPhase / emitStatus`

转成“job 驱动”的执行模型。

### 核心思路

不要重写 prompt runner，而是加一层：

```ts
runAgentJob(job) {
  registry.updateStatus(job.id, "running")
  runner.execute(job, {
    onStream,
    onToolEvent,
    onLifecycle,
  })
}
```

### `JobRunner` 需要做的事

1. 启动 job 时生成/关联 `runId`
2. 将 prompt runner 的 lifecycle 事件映射为 `AgentJobEvent`
3. 将 tool start/end 映射为 job 级事件
4. 将最终结果写回内存态 snapshot
5. 根据结果触发 delivery

### 与当前 `execution-flow` 的关系

第一阶段建议保留原路径：

- 普通消息仍直接走 `execution-flow`
- 新增配置开关使某些场景改走 `AgentJobRunner`

优先场景：

- reminders
- tools 触发的 follow-up
- 长时任务
- 用户显式要求“完成后再告诉我”

---

## Phase 3: Job Delivery（主动回访）

### 新增文件

- `src/runtime/jobs/delivery.ts`

### 职责

在 job 完成后执行主动投递：

- 根据 `channelId + peerId` 找到目标 channel
- 使用现有 `dispatchReply(...)` 或 channel send 接口发送结果
- 在 registry 中记录 delivery 事件

### 交付策略

#### 策略 A：直接发最终结果

适合：

- reminders
- tool follow-up
- 后台查询结果

#### 策略 B：先发确认，再发最终结果

适合：

- 长任务
- 用户明确要求异步完成通知

示例：

- 任务创建时：发送“已开始处理，完成后会通知你”
- 完成时：发送结果正文

### 初始版本建议

先实现：

- 仅支持最终结果投递
- delivery 失败只记录 event，不做复杂恢复
- 可选做一次有限重试

---

## Phase 4: Job Entry 接入点

### 接入点 A：Reminders

当前 reminders 已经是最自然的主动触发入口。

建议改造方式：

- reminder 到期后，不再只生成 inbound
- 而是允许配置为：
  - `enqueue inbound`（旧行为）
  - `create agent job`（新行为）

这样 reminders 就能成为第一条 agent job 生产通道。

### 接入点 B：Tools 触发 follow-up

当 tool 返回“稍后再继续”或“后台等待外部结果”时：

- 当前 turn 只确认已接收
- 创建一个 `kind = "tool_wait" | "background"` 的 job
- 后续由 job runner 继续执行并主动投递

### 接入点 C：Continuation 升级

不是删除 `ContinuationRegistry`，而是重新划边界：

- session 内短续跑：继续用 continuation
- 明确异步任务：升级为 agent job

判断标准可配置：

- 是否延迟超过阈值
- 是否需要脱离当前 turn
- 是否需要完成后主动通知

### 接入点 D：未来 API / ACP / 管理命令

后续可接：

- `createJob`
- `cancelJob`
- `jobStatus`

但不作为第一阶段阻塞项。

---

## 与现有模块的映射关系

| 现有模块 | 当前职责 | 新方案中的角色 |
| --- | --- | --- |
| `prompt-runner.ts` | 单次 prompt 执行与 fallback | 作为 JobRunner 的底层执行引擎 |
| `streaming.ts` | 文本流式输出 | 仍作为 job 内 streaming 能力 |
| `execution-flow.ts` | 当前 turn 主执行链 | 保留，用于普通即时对话 |
| `continuation.ts` | session 后续 prompt 队列 | 保留，部分场景升级为 AgentJob |
| `reminders/runner.ts` | 定时触发 inbound | 第一批 Job Entry |
| `storage/repos/tasks.ts` | 通用任务存储草案 | 不参与 AgentJob Runtime 设计 |

---

## 为什么不复用 `tasks` 表

当前已经明确：

- AgentJob 不应持久化为核心任务对象
- runtime 需要的是执行编排，而不是长期任务存储
- `tasks` 如果未来有意义，也应作为独立产品/插件能力存在

因此本方案直接排除：

- 复用 `tasks` 表
- 新增 `agent_jobs` 表
- 建立 job event 持久化表

---

## 插件化扩展边界

### 核心 runtime 只暴露执行语义

建议未来对外暴露的 lifecycle/hook 语义：

- `job_started`
- `job_waiting`
- `job_tool_start`
- `job_tool_end`
- `job_completed`
- `job_failed`
- `job_cancelled`
- `job_delivery_succeeded`
- `job_delivery_failed`

### 外部插件负责持久化/项目管理语义

例如未来的：

- kanban 插件
- issue 插件
- markdown task 插件
- git-based worklog 插件

都可以基于这些 lifecycle 事件工作。

### Kanban 插件示例

例如未来有 kanban 插件时：

- `job_started` -> 创建卡片或转 `In Progress`
- `job_waiting` -> 转 `Blocked`
- `job_completed` -> 转 `Done`
- `job_failed` -> 转 `Failed`
- `job_delivery_succeeded` -> 记录“已通知用户”

这样：

- runtime 保持轻量
- 持久化与协作模型可自由替换
- 核心不会被项目管理语义污染

---

## 配置设计

### 新增 runtime 配置

建议在 runtime config 中新增：

```ts
agentJobs?: {
  enabled?: boolean;
  maxConcurrent?: number;
  snapshotTtlMs?: number;
  deliveryRetries?: number;
  longTaskThresholdMs?: number;
  reminderMode?: "inbound" | "job";
}
```

### 默认策略建议

- `enabled: false`（先灰度）
- `maxConcurrent: 2`
- `snapshotTtlMs: 10 * 60_000`
- `deliveryRetries: 1`
- `longTaskThresholdMs: 15000`
- `reminderMode: "inbound"`

这样不会破坏现有默认行为。

---

## 实施阶段建议

## Stage 0: 文档与边界冻结

产物：

- 本 spec
- 后续任务拆分文档
- in-memory registry / waiter / delivery 边界定义

退出标准：

- 明确放弃内建持久化
- 明确将持久化转交未来插件

## Stage 1: In-Memory Registry

工作项：

- 新增 `AgentJob` 类型
- 新增 registry
- 新增 snapshot TTL
- 新增 `waitForAgentJob(...)`
- 状态机约束测试

退出标准：

- job create/get/update/cancel/wait 可用
- completed snapshot 可缓存并自动清理

## Stage 2: Runner 接入

工作项：

- 新增 `JobRunner`
- 复用 `runPromptWithFallback(...)`
- 将 lifecycle / tool events 映射为 job events
- 最终写入 snapshot

退出标准：

- job 能从 queued 走到 completed / failed / cancelled

## Stage 3: Delivery 接入

工作项：

- 完成后主动投递
- 交付成功/失败事件记录
- 最小重试策略

退出标准：

- 可在当前消息生命周期之外收到 job 结果

## Stage 4: Entry 接入

工作项：

- reminders 接 job 模式
- tools follow-up 接 job 模式
- continuation 与 job 的边界规则

退出标准：

- 至少一个真实入口可稳定创建 job 并主动回访

## Stage 5: 插件事件开放

工作项：

- 暴露 job lifecycle hooks/events
- 为未来 kanban/issue/task 插件预留扩展点
- 文档化事件语义与约束

退出标准：

- 外部插件可监听 job 生命周期并自行决定是否持久化

---

## 测试计划

### 单元测试

1. registry 状态迁移约束
2. waitForJob 超时/命中 snapshot 行为
3. snapshot TTL 清理行为
4. runner 生命周期映射
5. delivery 成功/失败行为
6. 配置默认值与开关行为

### 集成测试

1. 创建 job → 执行完成 → 主动投递结果
2. job 执行失败 → 记录 failed + 不重复投递
3. reminder 触发 job → 最终消息成功发送
4. tool follow-up 创建 job → job 接管后续执行
5. cancel job → 终态唯一

### 回归测试

1. 普通即时消息仍走原 `execution-flow`
2. 关闭 `agentJobs.enabled` 后行为与当前一致
3. streaming 现有链路不回归
4. Telegram / Discord 发送接口可直接复用

---

## 风险与缓解

### R1: Job 与现有 turn 流双写，导致重复回复

缓解：

- 明确 job 模式与即时 reply 模式互斥
- 在入口层做单一路径选择

### R2: In-memory 状态在重启后丢失

缓解：

- 明确接受该边界：job 是运行时对象，不做核心持久化
- 真正需要长期保留的信息由 docs/git/插件承担

### R3: delivery 失败后任务状态不清晰

缓解：

- 将“执行成功”和“投递成功”拆开记录
- `completed` 后允许单独记录 `job_delivery_failed`

### R4: 与 continuation 语义冲突

缓解：

- continuation 保持 session 内轻量续跑
- job 只承担明确的异步/后台/主动回访场景

### R5: 后续插件事件语义不稳定

缓解：

- 先冻结最小 lifecycle 事件集合
- 插件接口在 Stage 5 再正式开放

---

## 验收标准

满足以下条件即可认为第一阶段 Agent Job Runtime 落地成功：

1. 系统存在独立 `AgentJob` in-memory 实体
2. job 可从非聊天入口创建并执行
3. job 生命周期可等待、可诊断、可短期缓存
4. job 完成后可主动向原 channel/peer 投递结果
5. 普通消息问答链路不被破坏
6. reminders 至少有一个场景切换到 job 模式并验证成功
7. 设计上已明确：持久化由未来插件承担，而非核心 runtime

---

## 后续拆分建议

后续可以从本 spec 再拆成以下子任务文档：

1. `agent-job-runtime-phase-1-in-memory-registry.md`
2. `agent-job-runtime-phase-2-runner.md`
3. `agent-job-runtime-phase-3-delivery.md`
4. `agent-job-runtime-phase-4-reminder-entry.md`
5. `agent-job-runtime-phase-5-tool-followup.md`
6. `agent-job-runtime-phase-6-plugin-hooks.md`

每份子任务文档建议包含：

- 修改文件清单
- 接口定义
- 状态机变化
- 测试清单
- 验收标准

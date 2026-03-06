# Agent Job Runtime 任务细化与执行拆分

基于 `docs/specs/agent-job-runtime.md`，将第一阶段工作拆分为可以直接执行、验收、串并行调度的实现任务。

---

## 0. 目标重述

本批次只落地一套 **in-memory Agent Job Runtime**，核心闭环为：

1. 创建 `AgentJob`
2. 跟踪 job 生命周期
3. 允许外部等待 job 完成
4. job 完成后主动投递结果
5. 至少接入一个真实入口（优先 reminders）

### 本批次明确不做

- 数据库存储 `AgentJob`
- crash recovery / 重启恢复
- 长期任务历史查询
- 任务项目管理语义（kanban / issue / backlog）
- 为 `tasks` 表或新增 `agent_jobs` 表做适配

---

## 1. 总体执行顺序

推荐按以下顺序推进：

```text
T1 边界冻结
  ├─> T2 Registry & Types
  ├─> T3 Runner Integration
  │     └─> T4 Delivery
  │            └─> T5 Reminder Entry
  ├─> T6 Continuation / Tool Follow-up Boundary
  └─> T7 Config / Tests / Regression
```

### 串行依赖

- `T2` 必须先于 `T3`
- `T3` 必须先于 `T4`
- `T4` 基本先于 `T5`
- `T7` 依赖 `T2~T6` 全部完成

### 可并行部分

- `T6` 可在 `T3` 基本稳定后并行推进
- `T7` 中的测试草拟可提前开始，但最终落地要等前置任务完成

---

## 2. 任务拆分

## T1. 冻结边界与接口草案

### 目标

把 spec 从概念设计收敛成实现边界，避免后续任务反复解释语义。

### 输出物

- 本文档
- 核心运行时接口草案
- 状态机与事件语义冻结

### 需要冻结的事项

#### 1) 核心实体

```ts
export type AgentJobStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentJobSource =
  | "inbound"
  | "reminder"
  | "tool"
  | "api"
  | "system";

export type AgentJobKind =
  | "followup"
  | "background"
  | "scheduled"
  | "tool_wait";
```

#### 2) registry 对外接口

```ts
interface AgentJobRegistry {
  create(job: AgentJob): AgentJob;
  get(jobId: string): AgentJob | null;
  listActiveBySession(sessionKey: string): AgentJob[];
  appendEvent(event: AgentJobEvent): void;
  listEvents(jobId: string): AgentJobEvent[];
  updateStatus(
    jobId: string,
    nextStatus: AgentJobStatus,
    patch?: Partial<AgentJob>,
  ): AgentJob;
  complete(jobId: string, snapshot: AgentJobSnapshot): AgentJobSnapshot;
  cancel(jobId: string, reason?: string): AgentJobSnapshot | null;
  waitForJob(params: {
    jobId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<AgentJobSnapshot | null>;
  pruneSnapshots(now?: number): void;
}
```

#### 3) 运行器接口

```ts
interface RunAgentJobDeps {
  registry: AgentJobRegistry;
  delivery: AgentJobDelivery;
}

interface AgentJobRunner {
  run(job: AgentJob): Promise<AgentJobSnapshot>;
}
```

#### 4) delivery 接口

```ts
interface AgentJobDelivery {
  deliver(params: {
    job: AgentJob;
    snapshot: AgentJobSnapshot;
    text: string;
  }): Promise<void>;
}
```

### 验收标准

- 后续任务不再新增新的核心状态或核心终态
- `AgentJob`、`AgentJobSnapshot`、`AgentJobEvent` 的职责边界清晰
- 明确 registry / runner / delivery / entry 的模块责任

---

## T2. 实现 Registry & Types

### 建议文件

- `src/runtime/jobs/types.ts`
- `src/runtime/jobs/events.ts`
- `src/runtime/jobs/registry.ts`
- `src/runtime/jobs/index.ts`

### 目标

先把 job 作为一等 runtime object 建起来，不依赖 prompt runner。

### 具体工作

#### A. `types.ts`

定义并导出：

- `AgentJobStatus`
- `AgentJobSource`
- `AgentJobKind`
- `AgentJob`
- `AgentJobSnapshot`
- `AgentJobEvent`

建议补充：

```ts
export interface CreateAgentJobInput {
  sessionKey: string;
  agentId: string;
  channelId: string;
  peerId: string;
  source: AgentJobSource;
  kind: AgentJobKind;
  prompt: string;
  parentJobId?: string;
  traceId?: string;
}
```

#### B. `events.ts`

职责：

- 约束 job 事件类型
- 提供轻量 helper，如 `createJobEvent(...)`
- 统一事件 payload 结构

#### C. `registry.ts`

内部结构：

```ts
activeJobs: Map<string, AgentJob>
completedSnapshots: Map<string, AgentJobSnapshot>
jobWaiters: Map<string, Set<(snapshot: AgentJobSnapshot | null) => void>>
jobEvents: Map<string, AgentJobEvent[]>
```

功能要求：

1. `create(job)`
   - 仅接受 `queued` 初始态
   - 如 id 重复直接报错

2. `updateStatus(jobId, nextStatus, patch)`
   - 校验状态迁移是否合法
   - 自动补 `startedAt` / `finishedAt`

3. `complete(jobId, snapshot)`
   - 从 activeJobs 移除
   - 写入 completedSnapshots
   - 唤醒 waiters

4. `cancel(jobId)`
   - 生成终态 snapshot
   - 统一走 waiter 唤醒逻辑

5. `waitForJob(...)`
   - 已存在 snapshot 时立即返回
   - 超时返回 `null`
   - 支持 `AbortSignal`

6. `pruneSnapshots()`
   - 按 TTL 清理 completedSnapshots
   - 同步清理对应 event buffer（如果策略要求）

### 状态机冻结

只允许：

- `queued -> running`
- `running -> waiting`
- `running -> completed | failed | cancelled`
- `waiting -> running`
- `waiting -> completed | failed | cancelled`

### 测试清单

- 合法迁移通过
- 非法迁移抛错
- wait 命中 snapshot 立即返回
- wait 超时返回 `null`
- cancel 后终态唯一
- TTL 到期后 snapshot 被清理

### 验收标准

- 可在不接任何外部 runtime 的情况下，独立对 registry 做单元测试
- `waitForJob` 可作为后续 runner/delivery 的公共基础

---

## T3. 接入 JobRunner

### 建议文件

- `src/runtime/jobs/runner.ts`
- `src/runtime/jobs/job-context.ts`

### 目标

把现有 prompt 执行能力包到 job 生命周期中，而不是重写执行内核。

### 依赖现有模块

优先复用：

- `src/runtime/host/message-handler/services/prompt-runner.ts`
- `src/runtime/host/message-handler/flow/execution-flow.ts`
- 现有 streaming / lifecycle event emit 机制

### 具体工作

#### A. `job-context.ts`

定义 job 执行上下文：

```ts
interface AgentJobExecutionContext {
  jobId: string;
  sessionKey: string;
  agentId: string;
  traceId?: string;
  source: AgentJobSource;
  kind: AgentJobKind;
}
```

目的：

- 让下层执行链知道自己正处于 job 模式
- 后续可用于避免 turn-reply 和 job-delivery 双写

#### B. `runner.ts`

核心职责：

1. `queued -> running`
2. 生成/关联 `runId`
3. 订阅 prompt runner lifecycle
4. 把 stream/tool/lifecycle 映射为 `AgentJobEvent`
5. 收集最终结果摘要
6. 写入 snapshot
7. 调用 delivery

### 推荐最小接口

```ts
interface RunAgentJobResult {
  snapshot: AgentJobSnapshot;
  finalText: string;
}

async function runAgentJob(job: AgentJob): Promise<RunAgentJobResult>
```

### 事件映射约定

- run 启动 -> `job_started`
- tool start -> `job_tool_start`
- tool end -> `job_tool_end`
- 流式状态更新 -> `job_progress`
- 完成 -> `job_completed`
- 失败 -> `job_failed`
- 取消 -> `job_cancelled`

### 注意事项

- job 模式必须与当前 turn reply dispatch 互斥
- 不要求第一版支持复杂断点恢复
- 如果当前 runner 已能拿到最终文本，则只抽取最小必要数据，不新增大层重构

### 测试清单

- 成功执行写入 `completed`
- runner 异常写入 `failed`
- 取消信号能写入 `cancelled`
- tool start/end 可映射为 job events

### 验收标准

- 一个最小 job 可以独立跑完整 prompt 执行
- 执行终态与 snapshot 一致

---

## T4. 实现 Delivery

### 建议文件

- `src/runtime/jobs/delivery.ts`

### 目标

在 job 终态之后，把结果主动发回原 `channelId + peerId`。

### 具体工作

#### A. 定义投递时机

仅在以下终态尝试投递：

- `completed`
- 可选：`failed`（只投递简短失败消息）

第一版建议：

- `completed` 必投递
- `failed` 先只记 event，不一定通知用户

#### B. delivery 行为

1. 记录 `job_delivery_requested`
2. 调用现有 reply/channel send 能力
3. 成功后记录 `job_delivery_succeeded`
4. 失败后记录 `job_delivery_failed`
5. 按配置决定是否重试一次

### 文本来源

delivery 只依赖 runner 产出的：

- `finalText`
- 或 `snapshot.resultSummary`

避免 delivery 自己重新拼 prompt 或重新生成内容。

### 测试清单

- 正常投递成功
- 投递失败记录失败事件
- 重试次数受配置控制
- delivery 失败不改变 job 已完成终态

### 验收标准

- 执行成功与投递成功语义分离
- `completed` 后即使 delivery 失败，job 仍保持 completed

---

## T5. 接入 Reminder Entry

### 建议涉及文件

- reminder runner / scheduler 对应实现文件
- runtime config 文件
- 可能的 channel dispatch 适配层

### 目标

让 reminders 成为第一个真实 job 入口。

### 行为设计

新增配置：

```ts
agentJobs?: {
  enabled?: boolean;
  reminderMode?: "inbound" | "job";
}
```

触发逻辑：

- `enabled !== true` -> 保持旧行为
- `reminderMode === "inbound"` -> 保持旧行为
- `reminderMode === "job"` -> 创建 `source = "reminder"`, `kind = "scheduled"` 的 AgentJob

### 任务内容

1. reminder 到期后分流
2. 构造 `CreateAgentJobInput`
3. 提交给 registry/runner
4. 完成后走 delivery

### 测试清单

- 旧 inbound 模式不回归
- job 模式能创建任务
- 完成后成功主动回访

### 验收标准

- reminders 成为首个可验证的 job source
- 普通即时消息链路完全不受影响

---

## T6. 定义 Continuation / Tool Follow-up 边界

### 目标

明确哪些场景继续用 continuation，哪些场景升级为 AgentJob。

### 规则建议

#### continuation 继续处理的场景

- 同 session 内的短续跑
- 仍绑定当前 turn 体验
- 不需要主动通知用户
- 延迟短于 `longTaskThresholdMs`

#### 升级为 AgentJob 的场景

- 明确脱离当前 turn
- 外部等待较长
- 需要完成后主动通知
- tool 返回“稍后继续”或“后台等待外部结果”

### 产出物

至少冻结一份边界表：

| 场景 | continuation | AgentJob |
| --- | --- | --- |
| session 内轻量续跑 | 是 | 否 |
| reminder 到期触发 | 否 | 是 |
| tool 触发异步 follow-up | 否 | 是 |
| 当前消息内立即继续几步 | 是 | 否 |
| 用户明确要求“处理完再告诉我” | 否 | 是 |

### 验收标准

- 后续不会出现同一入口同时触发 continuation 与 AgentJob
- 有单一路径选择逻辑，避免重复回复

---

## T7. 配置、测试与回归

### 建议涉及文件

- runtime config schema/defaults
- jobs 相关单测
- reminder 集成测试
- execution-flow 回归测试

### 配置冻结

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

### 默认值建议

```ts
{
  enabled: false,
  maxConcurrent: 2,
  snapshotTtlMs: 10 * 60_000,
  deliveryRetries: 1,
  longTaskThresholdMs: 15_000,
  reminderMode: "inbound",
}
```

### 必测项

#### 单元测试

- registry 状态迁移
- waitForJob
- snapshot TTL
- runner 事件映射
- delivery 成功/失败
- 配置默认值

#### 集成测试

- create job -> execute -> deliver
- job failed -> failed snapshot + no duplicate deliver
- reminder -> job -> callback message
- cancel job -> single terminal state

#### 回归测试

- 普通 message 仍走原 `execution-flow`
- `agentJobs.enabled = false` 时与当前行为一致
- streaming 不回归
- Telegram/Discord 发送路径可复用

### 验收标准

- 开关关闭时零行为变化
- 至少一条真实入口链路打通
- 核心状态机、等待、投递、回归测试齐备

---

## 3. 推荐实现落点

### 新增目录

```text
src/runtime/jobs/
  types.ts
  events.ts
  registry.ts
  runner.ts
  delivery.ts
  job-context.ts
  index.ts
```

### 现有模块的最小侵入点

- `prompt-runner.ts`
  - 只做 runner 复用接线
  - 不重写主执行逻辑

- `execution-flow.ts`
  - 只增加 job 模式互斥判断或入口分流
  - 不把 execution-flow 重构成 job-only 模式

- reminders 相关模块
  - 增加 `inbound | job` 分流

- config schema/defaults
  - 增加 `agentJobs` 配置块

---

## 4. 实施建议

### 第一批提交建议

#### Commit A

- `src/runtime/jobs/types.ts`
- `src/runtime/jobs/events.ts`
- `src/runtime/jobs/registry.ts`
- registry tests

#### Commit B

- `src/runtime/jobs/runner.ts`
- `src/runtime/jobs/job-context.ts`
- runner tests

#### Commit C

- `src/runtime/jobs/delivery.ts`
- delivery tests

#### Commit D

- reminder entry integration
- config schema/defaults
- integration tests

#### Commit E

- continuation/tool follow-up 边界接入
- 回归测试补齐

这样更容易 review，也便于出现问题时回滚。

---

## 5. 开发时的硬约束

1. 不新增 DB schema
2. 不复用 `tasks` 表表达 runtime job
3. 不把 delivery 成功/失败混入 job 执行终态
4. 不允许同一入口同时走即时 reply 与 job delivery
5. 不为了 job 模式破坏现有 execution-flow 默认路径

---

## 6. 当前建议的直接下一步

按执行顺序，下一步直接开始：

1. 新增 `src/runtime/jobs/types.ts`
2. 新增 `src/runtime/jobs/events.ts`
3. 新增 `src/runtime/jobs/registry.ts`
4. 为 registry 写单元测试

也就是先完成 **T2: Registry & Types**，再进入 runner 接入。

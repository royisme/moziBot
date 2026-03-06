# Agent Job Runtime Gap Analysis

## 目的

这份文档不是重复现有 spec，而是用来冻结方向：明确 mozi 当前 AgentJob 实现里哪些是可接受的阶段性妥协，哪些如果继续保留就会把 runtime 长期带偏。

对比对象有三类：

- mozi 当前实现
- mozi 当前 spec：`docs/specs/agent-job-runtime.md`
- OpenClaw 默认 run/job 语义

核心判断标准只有一个：

- 如果某个设计只是为了第一阶段低风险落地，且不改变最终默认运行语义，它是“阶段性妥协”
- 如果某个设计把 job 永久放在 feature gate、旁路入口、或 reminder 专用分支里，它是“方向性偏差”

---

## 先给结论

### 一句话结论

mozi 现在已经做出了第一阶段可用骨架，但当前接法仍然是“把 AgentJob 挂在 reminder 分支上的可选能力”；这可以作为短期过渡存在，不能被视为目标态 runtime。

### 方向判断

- OpenClaw 的 run/job 语义本质上是默认基础设施，不是 feature gate 后的旁路模式
- mozi 当前 `agentJobs.enabled` / `reminderMode` 可以保留为阶段性灰度开关，但不能长期成为 runtime 的主边界
- 如果后续一直维持“普通流量走 old path，只有 reminder/job-mode 才走 AgentJob”，那最终会偏离 OpenClaw 风格 runtime

---

## 对比基线

## 1. OpenClaw 的 run/job 是否是默认基础设施，是否存在等价 gate

### 结论

OpenClaw 的 run/job 是默认基础设施。没有看到等价于 mozi `agentJobs.enabled` 或 `agentJobs.reminderMode` 的总开关，把 run/job 当成“默认关闭、按入口局部启用”的可选模式。

### 依据

#### 1) gateway 方法直接把 run 作为标准接口暴露

OpenClaw 在以下文件里直接把 agent run 作为标准 gateway 能力暴露：

- `../openclaw_source_github/src/gateway/server-methods-list.ts`
- `../openclaw_source_github/src/gateway/server-methods.ts`
- `../openclaw_source_github/src/gateway/server-methods/agent.ts`
- `../openclaw_source_github/src/gateway/server-methods/agent-job.ts`

具体可见：

- `server-methods-list.ts` 把 `agent`、`agent.wait` 列入基础方法集合
- `server-methods.ts` 直接把 `agentHandlers` 合入 `coreGatewayHandlers`
- `server-methods/agent.ts` 中 `agent` 请求先返回 accepted + `runId`，后续再完成；`agent.wait` 直接围绕 `runId` 等待终态
- `server-methods/agent-job.ts` 中 `waitForAgentJob({ runId, timeoutMs })` 是标准基础设施，而不是提醒器专用逻辑

这说明在 OpenClaw 里，“一次 agent run 可被外部等待和观察”是主路径能力，不是提醒器插件。

#### 2) isolated agent / cron 直接基于 run + delivery 编排

- `../openclaw_source_github/src/cron/isolated-agent/run.ts`
- `../openclaw_source_github/src/cron/isolated-agent/delivery-dispatch.ts`
- `../openclaw_source_github/src/infra/outbound/deliver.ts`

这些文件体现的不是“先决定开不开 job”，而是默认假设：

- run 是可创建、可跟踪的基本执行单元
- delivery 是 run 完成后的标准后续动作
- cron/isolated-agent 只是 run 的一个入口，不是单独发明另一套执行模型

#### 3) 没看到等价 feature gate

在本次引用文件范围内，没有看到以下风格的总开关：

- `agentJobs.enabled`
- `reminderMode: "inbound" | "job"`
- “只有 reminder 才能创建 job，其他入口默认不能”

OpenClaw 当然有很多 delivery/best-effort/channel 级别的策略参数，但这些是 runtime tuning，不是“run/job 语义是否存在”的 gate。

### 结论化表述

因此，OpenClaw 的默认语义是：

- run/job 是基础设施
- wait/delivery 是基础设施
- 上层入口决定如何使用它，但不会决定它是否存在

mozi 后续如果把 AgentJob 长期停在 feature gate 模式，本质上不是“还没做完”，而是“运行时哲学不同了”。

---

## 2. mozi 当前实现中哪些部分符合 spec，哪些只是第一阶段妥协

### 2.1 已经符合 spec 方向的部分

以下部分已经明显朝 spec 方向前进，属于可继续累积的资产。

#### A. 已经有独立的 AgentJob 配置域

文件：

- `src/config/schema/runtime.ts`

当前已有：

- `agentJobs.enabled`
- `agentJobs.maxConcurrent`
- `agentJobs.snapshotTtlMs`
- `agentJobs.deliveryRetries`
- `agentJobs.longTaskThresholdMs`
- `agentJobs.reminderMode`

这至少说明 mozi 已经把 AgentJob 当成一个独立 runtime concern，而不是散落在 reminder/cron 内的局部 hack。

#### B. RuntimeHost 已经创建 job registry / runner / delivery

文件：

- `src/runtime/host/index.ts`

当前行为：

- 创建 `InMemoryAgentJobRegistry`
- 创建 `AgentJobDelivery`
- 创建 `AgentJobRunner`
- 将 delivery 接到 channel registry 的发送接口
- 将 reminder runner 接到 job runner / job registry

这和 spec 里的几个核心层次是对齐的：

- registry
- runner
- delivery
- entry

虽然接入范围还很窄，但骨架方向是对的。

#### C. reminder 已支持创建 job，而不只是生成 inbound

文件：

- `src/runtime/host/reminders/runner.ts`

当前已经支持：

- reminder 到期后，不仅可以 `enqueueInbound`
- 还可以在 `reminderMode === "job"` 时创建 job 并执行

这与 spec 中“reminders 是第一条 job 生产通道”的说法一致。

#### D. 当前实现仍保持 in-memory first

参考：

- `docs/specs/agent-job-runtime.md`
- `src/runtime/host/index.ts`
- `src/runtime/host/reminders/runner.ts`

当前接法没有把 AgentJob 直接落到数据库任务表里，也没有把 runtime 先绑死到 durable task schema。这一点与 spec 的大方向一致。

这部分必须明确：

- “不做持久化任务系统”本身不是偏差
- 真正的偏差是“把 AgentJob 只做成 reminder 旁路特性”

### 2.2 明确属于第一阶段妥协的部分

以下设计可以接受，但只能按“阶段一临时安排”解释，不能写成长期原则。

#### A. `agentJobs.enabled` 总开关

文件：

- `src/config/schema/runtime.ts`
- `src/runtime/host/index.ts`

当前 `RuntimeHost` 的逻辑是：

- 若 `agentJobs.enabled` 为真，则 reminder runner 可根据 `reminderMode` 走 job
- 否则 reminder 一律回退到 `inbound`

这作为灰度开关合理，但它不是目标态接口。目标态里不应该还需要一个“AgentJob 基础设施是否存在”的总开关。

#### B. `reminderMode: "inbound" | "job"`

文件：

- `src/config/schema/runtime.ts`
- `src/runtime/host/reminders/runner.ts`

这也是典型阶段性妥协。

它的价值在于：

- 允许 reminder 入口低风险切换
- 便于回归验证 old path/new path

但它只适合用来验证 reminder entry，不适合作为长期 runtime 分层。长期保留会让系统默认假设：

- reminder 有两种执行语义
- job 只是 reminder 的一种可选特性

这与 OpenClaw 风格明显不同。

#### C. AgentJob 仍然由 RuntimeHost 局部装配，而不是主执行模型的一部分

文件：

- `src/runtime/host/index.ts`

当前装配方式更像：

- RuntimeHost 启动时额外挂了一套 jobs 能力
- 然后只把它接给 ReminderRunner

这在第一阶段是合理的，因为改动面小、风险可控；但如果长期保持，就说明 AgentJob 不是 runtime 主骨架，只是 host 上的插件附件。

#### D. AgentJob 当前入口基本只有 reminder

文件：

- `src/runtime/host/reminders/runner.ts`
- 对照 spec：`docs/specs/agent-job-runtime.md`

spec 里说得很清楚，job entry 至少包括：

- inbound
- reminder
- tool
- api
- system

而当前落地可见的稳定入口基本只有 reminder。这个不是错误，但必须明确标注为“第一阶段只验证一个入口”，不能误读成最终边界定义。

---

## 3. 哪些设计如果长期保留，会偏离 OpenClaw 风格 runtime

这里是最重要的部分。

### 偏差 1：把 AgentJob 长期定义成 feature-gated 子系统

表现：

- `agentJobs.enabled` 长期决定 AgentJob 是否存在
- 默认主链路永远不依赖 AgentJob
- 只有手动开启时才有 wait/job/delivery 语义

为什么这是偏差：

OpenClaw 的 run/job 不是 feature gate 后的增强能力，而是默认执行基础设施。继续把 mozi AgentJob 放在总开关后面，意味着：

- old runtime 才是“真的 runtime”
- AgentJob 只是“可选插件”

这会直接阻碍后续统一：

- 统一 run identity
- 统一 terminal snapshot / waiting
- 统一 delivery after completion
- 统一入口语义

结论：

- 短期可保留
- 长期必须去掉“基础设施存在性”的 gate

### 偏差 2：把 reminder 当成 AgentJob 的长期唯一主入口

表现：

- reminder 可以 job 化
- 但普通 agent run、tool follow-up、API 创建任务仍然不走统一 job 语义

为什么这是偏差：

这样最后得到的不是 AgentJob runtime，而是“reminder async mode”。

OpenClaw 风格里，cron/isolated-agent 只是入口之一；run 本身是底层抽象。mozi 如果长期只在 reminder 路上使用 job，那么：

- job 语义无法反向塑造主执行模型
- tool/background/wait-completion 仍会各自发明半套机制
- reminder 成为唯一拥有异步交付语义的特殊分支

这不是阶段不完整，而是抽象层级错了。

### 偏差 3：长期保留“普通消息 = execution-flow；job = 旁路 runner” 的硬分叉

参考文件：

- `docs/specs/agent-job-runtime.md`
- `src/runtime/host/index.ts`

spec 在阶段一允许：

- 普通消息仍走 `execution-flow`
- 特定场景走 `AgentJobRunner`

但如果长期保留这种分叉，风险很高：

- lifecycle 事件会分裂
- completion / cancellation / wait 语义会分裂
- 某些入口可主动投递，某些入口永远不能
- 调试与测试永远要维护两套主路径

OpenClaw 的做法不是完全没有不同入口，而是入口最终都落到统一 run 观测模型上。

因此，阶段一允许双轨；目标态不能永久双轨。

### 偏差 4：把 `reminderMode` 当长期产品接口

`reminderMode: "inbound" | "job"` 如果长期暴露，就在暗示 reminder 的本质是“可选地是否创建 job”。

更合理的目标态是：

- reminder 是一种 entry source
- 它天然创建某种 run/job
- 剩下只是 runtime tuning，而不是语义分流

换句话说：

- `source` 可以是 reminder
- 但 `mode` 不应长期是 inbound vs job

### 偏差 5：把 `longTaskThresholdMs` 理解成“是否升级为 job”的总判定

文件：

- `src/config/schema/runtime.ts`

这个字段如果被长期用作核心分流规则，例如：

- 小于阈值走普通 prompt
- 大于阈值才升级成 AgentJob

那也会把 job 永久降格为“慢任务特判”。

OpenClaw 风格不是“只有慢任务才是 run/job”，而是 run/job 本来就是运行基本单位，只是不同入口和交付策略不同。

因此该字段最多只能是 tuning 信号，不能是长期抽象边界。

---

## 4. 后续演进时哪些配置应保留为 runtime tuning，哪些应移除

这里要把“可保留的调参项”和“必须下掉的阶段性开关”分清楚。

### 4.1 应保留为 runtime tuning 的配置

#### `maxConcurrent`

保留。

理由：

这是典型运行时容量控制，不改变语义，只调度资源。

#### `snapshotTtlMs`

保留。

理由：

OpenClaw 在 `../openclaw_source_github/src/gateway/server-methods/agent-job.ts` 中也明确有 run cache TTL 思路。缓存多久是 tuning，不是产品语义。

#### `deliveryRetries`

保留，但建议逐步改名靠近 delivery policy 语义。

理由：

delivery retry 是典型运行策略，不决定是否存在 run/job。

#### `longTaskThresholdMs`

可短中期保留，但必须降级为启发式信号，而不是系统边界。

允许用途：

- 是否先给用户确认语
- 是否切换 UI 提示
- 是否追加“完成后通知你”的确认

不允许用途：

- 长期决定“是否创建 AgentJob”
- 作为 old path / new path 的永久分叉条件

### 4.2 只允许阶段性存在，后续应移除的配置

#### `enabled`

建议：

- 当前阶段可保留，用于灰度
- 下一阶段开始收缩使用面
- 目标态移除“AgentJob 基础设施存在性”的总开关

替代方式：

- 允许保留更具体的入口级 rollout/config
- 但不再允许整个 runtime 是否有 AgentJob 由总开关决定

#### `reminderMode`

建议：

- 第一阶段可保留，只用于 reminder 迁移
- reminder 稳定后应移除

目标态应改成：

- reminder 直接作为一种 job/run source
- 不再维护 `inbound` 与 `job` 两套长期等价模式

### 4.3 不建议继续新增的配置类型

以下方向禁止继续扩展，否则会进一步固化 feature gate 思维：

- `toolMode: "turn" | "job"`
- `apiMode: "legacy" | "job"`
- `inboundMode: "execution-flow" | "job"`
- 类似“每个入口各自有一套是否 job 化”的总开关

这类配置短期看像灵活，长期看是在制度化 runtime 分裂。

---

## 5. 测试验收应该如何区分“第一阶段验收”和“目标态验收”

这是当前最容易做偏的地方。

如果不区分两个层次，团队很容易在“reminder 能跑通 job”后误以为 runtime 已经定型。

### 5.1 第一阶段验收

第一阶段只回答：AgentJob 骨架是否存在，且能在受控入口上闭环。

建议验收口径：

1. reminder 在 job 模式下可创建独立 job 并执行完成
2. job 完成后可通过 delivery 主动发送结果
3. 有短期 snapshot / wait 能力
4. 关闭 `agentJobs.enabled` 后不影响旧链路
5. 普通即时消息链路不回归

这类验收对应的是“骨架落地成功”，不是“runtime 已完成迁移”。

### 5.2 目标态验收

目标态必须回答的是：AgentJob / run 是否已经成为统一基础设施，而不是 reminder 专用分支。

建议目标态验收至少包括：

1. 非 reminder 入口也可稳定落到统一 run/job 语义
   - 至少包括一种 tool follow-up 或 API 创建入口
2. wait / terminal snapshot 不再只是 reminder job 专属能力
3. delivery after completion 是统一 runtime 行为，不是 reminder 特化
4. execution-flow 与 job runner 的边界开始收敛，而不是永久双轨
5. 去掉或实质废弃 `reminderMode`
6. `enabled` 不再决定基础设施是否存在，只剩 rollout 或兼容性残留价值；最终可删除

### 5.3 测试文档上必须避免的误导写法

以下表述不应再作为“最终验收”标准：

- “reminder 支持 job 模式即可视为 AgentJob 完成”
- “开启 feature gate 后跑通就算完成”
- “只要 old path 不受影响，job 永远保持可选即可”

这些都只能算阶段一验收，不是目标态验收。

---

## 6. 按文件逐项判断：当前状态、可接受性、后续要求

## A. mozi spec

### `docs/specs/agent-job-runtime.md`

#### 对齐的地方

- 明确提出 `AgentJob` 是一等实体
- 明确提出 registry / runner / delivery / entry 四层
- 明确提出 reminders 只是第一批入口
- 明确提出 wait/snapshot/event 语义
- 明确坚持 in-memory first，不把持久化当 runtime 核心

#### 需要额外冻结的地方

这份 spec 本身允许阶段一保守落地，但没有足够强地强调：

- `enabled` / `reminderMode` 只是迁移手段，不是长期产品边界
- reminders 只是第一批入口，不是最终唯一入口
- execution-flow 与 AgentJobRunner 双轨只是暂态，不是目标态

本次 gap 文档就是补这层约束。

## B. runtime config

### `src/config/schema/runtime.ts`

#### 当前价值

- 已经把 AgentJob 配置集中起来，便于演进

#### 风险点

- `enabled`
- `reminderMode`

这两个字段如果不标注生命周期，会非常容易被后续实现者理解为“设计本来如此”。

#### 冻结意见

- `maxConcurrent` / `snapshotTtlMs` / `deliveryRetries` 可长期保留
- `longTaskThresholdMs` 只做 tuning，不做边界
- `enabled` / `reminderMode` 标注为阶段性兼容配置，后续删除

## C. runtime host

### `src/runtime/host/index.ts`

#### 当前价值

- 已完成 registry/runner/delivery 装配
- 已把 channel 发送能力接到 job delivery
- 已把 reminder runner 接上 job 体系

#### 风险点

当前代码结构传达出的语义仍然是：

- AgentJob 是 host 上额外挂件
- 只有 reminder 使用它

#### 冻结意见

当前这样接法可以继续一段时间，但下一阶段必须把 AgentJob 从“host 局部附件”推进为“runtime 主执行模型的一部分”。

## D. reminder runner

### `src/runtime/host/reminders/runner.ts`

#### 当前价值

- 已经验证了 reminder 可创建 job
- 已经把 `source: "reminder"`、`kind: "scheduled"` 这类语义显式化

#### 风险点

- `reminderMode === "job"` 让 reminder 看起来像唯一支持 job 的特殊入口
- `reminderMode === "inbound"` 与 `job` 双态长期存在，会把语义停在 feature gate 迁移层

#### 冻结意见

- 允许作为 reminder 迁移开关短期存在
- reminder 稳定后必须收敛成统一 run/job 入口，不再保留长期双态

---

## 7. OpenClaw 参考语义：对 mozi 最值得借鉴的不是实现细节，而是抽象位置

## A. run 是默认可观察对象

文件：

- `../openclaw_source_github/src/gateway/server-methods/agent.ts`
- `../openclaw_source_github/src/gateway/server-methods/agent-job.ts`

最重要的不是 API 名字，而是语义：

- run 有 `runId`
- run 可先 accepted、后完成
- run 可 wait
- run 的 terminal snapshot 是基础设施

mozi 要学的是这个地位，不是是否逐字复刻 gateway 形式。

## B. delivery 是 run 完成后的标准后续动作

文件：

- `../openclaw_source_github/src/cron/isolated-agent/delivery-dispatch.ts`
- `../openclaw_source_github/src/infra/outbound/deliver.ts`

OpenClaw 的 delivery 很复杂，但有一个非常清楚的结构：

- run 成功与 delivery 成功分开记录
- delivery 是执行完成后的正常编排层，不是聊天消息链路内的偶发补丁

mozi 当前方向是对的，但要避免把 delivery 永久限定为 reminder 的尾部发送逻辑。

## C. 入口可以多样，但 run 语义不应碎片化

文件：

- `../openclaw_source_github/src/gateway/server-methods-list.ts`
- `../openclaw_source_github/src/gateway/server-methods.ts`
- `../openclaw_source_github/src/cron/isolated-agent/run.ts`

OpenClaw 不是只有一种入口；但不同入口最终共享 run 可等待、可缓存终态、可 delivery 的基础语义。

mozi 后续也应该朝这个方向收敛，而不是给每个入口都设计一个自己的异步例外路径。

---

## 8. 明确建议

## 当前阶段可接受的策略

以下策略当前可以接受：

1. 保留 `agentJobs.enabled` 作为灰度开关
2. 保留 `reminderMode` 作为 reminder 迁移开关
3. 先只用 reminder 验证 registry / runner / delivery / wait 闭环
4. 继续坚持 in-memory first，不急着引入 durable task persistence
5. 保持普通消息链路不回归

但这些都必须带一个前提说明：

- 它们只是为了低风险迁移，不代表最终 runtime 设计

## 下一阶段要改的事项

下一阶段建议优先做这些，而不是继续堆 reminder 特判：

1. 增加第二个真实 job 入口
   - 首选 tool follow-up
   - 备选 API / system 入口
2. 把 wait/snapshot 语义从 reminder 专用能力提升为更通用的 runtime 能力
3. 开始收敛 execution-flow 与 AgentJobRunner 的边界
4. 重新定义 `longTaskThresholdMs`
   - 只做体验与调度信号
   - 不做是否进入 job 的长期分界线
5. 在文档和代码注释中明确 `enabled` / `reminderMode` 的退场计划

## 禁止继续沿用的方向

以下方向建议明确禁止：

1. 禁止把 AgentJob 长期定义成 feature gate 模式
2. 禁止把 reminder 作为 AgentJob 唯一或默认长期入口
3. 禁止继续新增一批 `xxxMode: legacy | job` 配置，把每个入口都做成分叉迁移层
4. 禁止把 `longTaskThresholdMs` 固化成“慢任务才配有 job”的长期产品定义
5. 禁止把“阶段一 reminder 跑通”包装成“runtime 已经定型”

---

## 最终冻结结论

### 应该如何理解当前实现

当前 mozi AgentJob 实现应被定义为：

- 已经具备方向正确的第一阶段 runtime 骨架
- 但目前仍处于 reminder 驱动、feature-gated、旁路接入的迁移态

### 应该如何理解目标方向

目标方向不是“让 reminder 多一个 job 模式”，而是：

- 让 run/job 成为默认 runtime 基础设施
- 让 wait/snapshot/delivery 成为默认 runtime 语义
- 让 reminder 只是其中一个 source，而不是唯一特权入口

### 团队后续判断标准

以后看到任何 AgentJob 相关设计，都用下面这条判断：

- 如果它在缩小 old path 与 job path 的语义差距，是朝目标态前进
- 如果它在继续固化 `enabled`、`reminderMode`、入口级双模配置，那就是在把第一阶段妥协变成长期偏差

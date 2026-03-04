# OpenClaw -> Mozi 迁移蓝图

## 背景与目标

为避免迁移过程中出现设计漂移、任务断层与信息丢失，先沉淀迁移蓝图文档，作为后续所有实现、评审与验收的单一基线。

本蓝图聚焦将 OpenClaw 已验证能力按 Mozi 当前架构有序落地，原则是：

1. 能力对齐优先于实现细节对齐
2. 先可运行，再可扩展，再可优化
3. 每阶段必须具备可验证产物与回滚边界

## 迁移范围

### In Scope

- ACP Control Plane 能力对齐（会话生命周期、路由、调度、策略）
- ACP Bridge/Translator 能力对齐（协议映射、会话映射、事件映射）
- Runtime 关键执行链路对齐（argv first、shell wrapper、事件驱动唤醒）
- 配置模型对齐（schema、默认值、策略开关、兼容行为）
- 观测与可靠性（状态、诊断、错误归因、测试矩阵）

### Out of Scope（当前批次）

- 非核心新特性扩展（和迁移无直接关系）
- 大规模 UI/交互层重构
- 非必要的历史模块清理与重命名

## 设计原则

### 1) 兼容性优先

- 保持现有 Mozi 使用方式可继续工作
- 新能力通过显式配置开关启用
- 关键破坏性变更提供迁移提示与回退路径

### 2) 分层迁移

- 类型/协议层
- 运行时基础层
- 控制平面层
- 桥接与入口层
- 命令与用户触点层

### 3) 可回归验证

- 每阶段都必须落地最小测试闭环
- 阶段验收以“行为等价”而非“代码相似”作为标准

## 目标架构映射

| OpenClaw 能力域 | Mozi 对应落点 | 迁移重点 |
| --- | --- | --- |
| ACP Runtime Types + Registry | `src/acp/*` | 统一运行时抽象、后端注册和能力探测 |
| Session Identity / Policy | `src/runtime/*`, `src/config/schema/*` | session key 规则、策略检查、配置约束 |
| Control Plane Manager | `src/acp/*`, `src/runtime/host/*` | 会话状态机、调度、并发与取消 |
| Dispatch + Reply Projection | `src/runtime/*` | 事件到用户可见输出的稳定映射 |
| ACP Bridge Server/Translator | `src/acp/bridge/*` | ACP 协议方法落地、流式事件转换 |
| CLI / Commands | `src/cli/*`, `src/agents/*` | spawn/status/cancel 等入口一致性 |
| Exec + Heartbeat Loop | `src/runtime/*`, `src/infra/*` | 事件驱动循环、连续跟进输出 |

## 能力差异矩阵基线（P0）

### 核心能力域矩阵（OpenClaw vs Mozi）

| 能力域 | OpenClaw 基线能力 | Mozi 当前状态 | 主要差异（可执行口径） | 迁移策略 | 优先级 | 关键依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| ACP runtime | 统一 runtime 抽象、事件与错误语义稳定 | 部分实现 | 运行时事件语义与错误归因尚未完全对齐，注册与能力探测口径不统一 | 适配（已有 runtime 抽象上补齐语义） | P0-P1 | 类型/schema 对齐先行 |
| Control Plane | 完整 session 生命周期（spawn/run/cancel/status/close）与调度闭环 | 部分实现 | 会话状态机、并发取消、TTL 驱逐与线程绑定需统一 | 适配 + 局部重写（核心状态机） | P1-P2 | runtime/types 稳定后推进 |
| Bridge | ACP bridge server + translator + 事件映射稳定 | 缺失/早期 | ACP 方法面覆盖不足，session/event mapper 未形成稳定层 | 重写（按 ACP 方法清单实现） | P2-P3 | Control Plane 生命周期稳定 |
| Exec / Heartbeat | 执行完成后可事件驱动持续跟进，heartbeat 与 event queue 协同 | 部分实现 | argv-first、shell wrapper、system event queue 与 wake 时序需要闭环化 | 适配（复用现有 heartbeat，补事件驱动链路） | P2-P4 | Control Plane 事件流接口 |
| Config | schema、默认值、策略开关清晰且兼容 | 部分实现 | 迁移字段定义、默认行为与兼容规则仍分散 | 复用 + 适配（沿用现有 schema 框架） | P0-P1 | 与 runtime/policy 同步演进 |

### 渠道对齐差异矩阵（Telegram / Discord）

> 说明：本矩阵用于补齐你要求的 OpenClaw vs Mozi 在 Telegram/Discord 维度的可执行差异清单；以 Mozi 当前代码与迁移文档口径为准。

| 维度 | OpenClaw 基线（迁移目标） | Mozi 当前状态 | 差异结论 | 代码/文档锚点 |
| --- | --- | --- | --- | --- |
| 基础收发（Telegram） | 支持稳定 inbound/outbound、命令触发、错误可恢复 | 已实现 | 已对齐（保留持续验证） | `src/runtime/adapters/channels/telegram/plugin.ts` |
| 基础收发（Discord） | 支持稳定 inbound/outbound、命令触发、错误可恢复 | 已实现 | 已对齐（保留持续验证） | `src/runtime/adapters/channels/discord/plugin.ts` |
| 消息分块策略 | 长消息分块、避免平台长度上限失败 | 已实现（Discord 2000 chars；Telegram 渲染+发送路径） | 基本对齐；待补 markdown-aware 一致性策略 | `src/runtime/adapters/channels/discord/plugin.ts`, `docs/ROADMAP_DISCORD.md` |
| silent / replyTo 语义 | 静默发送与首条回复引用语义一致 | Discord 已明确实现；Telegram 路径可用 | 需要补跨渠道一致性回归用例 | `src/runtime/adapters/channels/discord/plugin.ts` |
| 状态反应（status reactions） | thinking/tool/done/error 可视化反馈 | Telegram/Discord 均支持配置 | 已对齐 | `docs/MODULES/channels.md` |
| 角色访问控制与路由（Discord） | 群角色准入与按角色路由 agent | 已实现 | 已对齐（需持续回归） | `src/runtime/adapters/channels/discord/plugin.ts`, `docs/MODULES/channels.md` |
| 原生命令注册（Telegram） | 平台原生命令可发现 | 已实现 `setMyCommands` | 已对齐 | `src/runtime/adapters/channels/telegram/plugin.ts`, `docs/MODULES/channels.md` |
| 组件/按钮交互（Discord） | 交互组件可触发路由命令 | 已有拦截与路由基础 | 部分对齐；需补完整组件协议与回归测试 | `src/runtime/adapters/channels/discord/plugin.ts` |
| 轮询/投票（Discord） | 支持 poll | 未完成 | 待补齐 | `docs/ROADMAP_DISCORD.md` |
| Webhook 发送（Discord） | 支持 webhook send | 未完成 | 待补齐 | `docs/ROADMAP_DISCORD.md` |
| 语音消息发送（Discord） | 支持 voice message send | 未完成 | 待补齐 | `docs/ROADMAP_DISCORD.md` |
| URL 媒体上传（Discord） | URL 下载后带大小护栏上传 | 未完成 | 待补齐 | `docs/ROADMAP_DISCORD.md` |
| Forum/media 线程自动创建（Discord） | 自动 thread create | 未完成 | 待补齐 | `docs/ROADMAP_DISCORD.md` |
| 权限诊断与错误展开（Discord） | 可定位权限失败原因 | 部分实现 | 待增强 | `docs/ROADMAP_DISCORD.md` |
| 历史检索与 pin/unpin（Discord） | 搜索历史与消息管理 | 未完成 | 待补齐 | `docs/ROADMAP_DISCORD.md` |

### Telegram / Discord 收口清单（必须项）

- [x] T/D-1: 产出跨渠道语义对齐测试（silent、replyTo、chunk、status reactions）
- [x] T/D-2: 补齐 Discord roadmap 剩余能力最小闭环（components/polls/webhook/URL media）
  - 已完成第一批：components/buttons + polls + webhook send（含可诊断失败路径）
  - 已完成第二批：URL media 上传 + 大小护栏 + 失败降级
- [ ] T/D-3: 对齐 CLI/slash 在 Telegram/Discord 的可见行为（同输入同终态）
- [x] T/D-4: 补运维排障条目（权限失败、分块失败、线程创建失败）
- [ ] T/D-5: 在 P5 门禁中增加 Telegram/Discord 专项 Go/No-Go

### 分项差异与落地策略

#### 1) ACP runtime

- Gap-R1: 事件语义（started/progress/done/error）与 OpenClaw 口径存在偏差
  - 策略: 适配
  - 动作: 统一 `AcpRuntimeEvent` 投影规则，补齐 done/error 时序断言测试
  - 优先级: 高
  - 依赖: 无（可在 P1 直接推进）
- Gap-R2: runtime registry 能力探测维度不一致
  - 策略: 适配
  - 动作: 对齐注册元数据字段，保证后端选择策略可预测
  - 优先级: 中
  - 依赖: 配置 schema 字段冻结

#### 2) Control Plane

- Gap-C1: session 生命周期闭环不完整（尤其 cancel/close 边界）
  - 策略: 局部重写
  - 动作: 抽象统一状态机，固定 `spawn -> run -> done/error -> close` 路径
  - 优先级: 高
  - 依赖: ACP runtime 事件语义稳定
- Gap-C2: 并发隔离、TTL 驱逐与线程绑定规则未统一
  - 策略: 适配
  - 动作: 统一 session key 与路由策略，补并发/回放测试
  - 优先级: 高
  - 依赖: session identity 规范确定

#### 3) Bridge

- Gap-B1: ACP 方法覆盖不全（initialize/newSession/loadSession/prompt/cancel/status）
  - 策略: 重写
  - 动作: 按方法清单建立 bridge handler 与 translator 分层
  - 优先级: 高
  - 依赖: Control Plane 接口稳定
- Gap-B2: event mapper 缺少稳定映射约束
  - 策略: 适配
  - 动作: 定义统一映射表与异常降级策略
  - 优先级: 中
  - 依赖: runtime event schema 固化

#### 4) Exec / Heartbeat

- Gap-E1: 执行后自动续跑（follow-up turn）触发条件不稳定
  - 策略: 适配
  - 动作: 以 system event queue 驱动 wake，保留 heartbeat 兜底
  - 优先级: 高
  - 依赖: Control Plane dispatch 接口
- Gap-E2: shell wrapper 检测与 argv-first 执行模型边界不清
  - 策略: 适配
  - 动作: 固化检测规则与错误提示，补平台差异测试
  - 优先级: 中
  - 依赖: 配置策略项冻结

#### 5) Config

- Gap-F1: 配置字段分散，默认行为解释成本高
  - 策略: 复用 + 适配
  - 动作: 在既有 schema 体系中收敛迁移字段并补默认值说明
  - 优先级: 高
  - 依赖: runtime/policy 字段命名统一
- Gap-F2: 兼容开关缺少分阶段启用建议
  - 策略: 适配
  - 动作: 给出 P1/P2/P3 启用建议与回滚开关
  - 优先级: 中
  - 依赖: Phase 计划与验收口径

### 优先级与依赖总览

- 第一优先（先做）: Config 基线收敛 + ACP runtime 事件语义对齐（P0-P1）
- 第二优先（并行）: Control Plane 生命周期闭环与并发隔离（P1-P2）
- 第三优先（后接）: Bridge ACP 方法面与映射层完整落地（P2-P3）
- 持续推进（与 P2 同步）: Exec/Heartbeat 事件驱动闭环（P2-P4）

阻塞关系（最小依赖链）：

1. Config/Types 基线 -> runtime 语义稳定
2. runtime 语义稳定 -> Control Plane 闭环
3. Control Plane 闭环 -> Bridge 方法与映射稳定
4. Control Plane 事件接口稳定 -> Exec/Heartbeat 持续推送稳定

## 交付物清单（文档先行）

1. 蓝图总文档（本文件）
2. 分阶段实施计划（`OPENCLAW_TO_MOZI_PHASE_PLAN.md`）
3. 任务拆分规范（`.claude/task-specs/openclaw-mozi-migration-20260303T000000/*`）
4. 运行状态文件（`.claude/dispatch/runs/openclaw-mozi-migration-20260303T000000/state.json`）

## 风险与缓解

### R1: 协议对齐不完整

- 表现：ACP 客户端行为异常、方法语义偏差
- 缓解：建立 ACP 方法级别验收清单（initialize/newSession/loadSession/prompt/cancel/...）

### R2: 会话与线程绑定漂移

- 表现：路由错位、上下文混淆、重复执行
- 缓解：统一 session key 规范 + 持久化边界 + 回放测试

### R3: 流式链路不稳定

- 表现：输出抖动、丢块、done/error 时序异常
- 缓解：coalesce 策略测试、事件时序断言、端到端回归

### R4: 配置复杂度上升

- 表现：用户配置难以理解、默认行为不确定
- 缓解：schema 收敛、默认值清晰、文档与示例同步

## 验收总标准

1. 关键迁移能力具备可复现的端到端流程
2. 每阶段有对应测试证据（单元/集成/冒烟）
3. 主要入口（CLI/agent tool/slash commands）行为一致且可回退
4. 配置文档与实现保持一致

## P5 稳定化收口与发布门禁

### P5 发布检查清单（Go/No-Go）

以下所有门禁项必须全部通过方可发布。

#### G1 — 测试覆盖（强制）

- [ ] `pnpm run test` 全量通过，零 failure
- [ ] 回归矩阵（Unit / Integration / E2E / Smoke）逐层通过并有执行报告
- [ ] P4 验收场景矩阵 P4-S1~P4-S8 全部可复现，日志/截图存档
- [ ] 无因迁移引入的新 TypeScript 编译错误

#### G2 — 功能完整性（强制）

- [ ] Control Plane 全链路：`spawn → run → done/error → close` 可在 CI 稳定复现
- [ ] Bridge：initialize / newSession / loadSession / prompt / cancel / status 全方法覆盖
- [ ] CLI 与 slash commands 同场景输出一致
- [ ] exec 完成后持续推送闭环（P4-S4）稳定触发
- [ ] 旧配置字段兼容行为符合 P1 优先级规则

#### G3 — 回滚可操作（强制）

- [ ] 每个 feature flag 有对应关闭路径且已验证
- [ ] 全量回退到迁移前基线的步骤文档完整且可执行
- [ ] 灾难场景（runtime 崩溃、session 泄漏）排障入口已文档化

#### G4 — 文档与可观测性（强制）

- [ ] `docs/CONFIGURATION_GUIDE.md` 与 schema 字段一致
- [ ] 日志可区分 `scheduled_heartbeat` 与 `event_wake_heartbeat`
- [ ] 排障速查表（故障现象 → 排查命令 → 定位路径）已完成

#### G5 — 风险关闭（强制）

- [ ] 蓝图 Gap 矩阵（R1/R2/C1/C2/B1/B2/E1/E2/F1/F2）各项标注 done 或显式降级决策
- [ ] P4 风险矩阵 R1~R5 各项标注"已缓解"或"已接受（附原因）"
- [ ] 无遗留 Critical/High 级别未闭合 issue

#### G6 — 发布操作准备（强制）

- [ ] 迁移状态文件更新为 `status: "completed"`
- [ ] 版本 tag / changelog 已准备，包含本次迁移范围说明
- [ ] 至少一名非作者 reviewer approve

---

### P5 回归矩阵

| 层级 | 覆盖范围 | 执行命令 | 通过标准 |
| --- | --- | --- | --- |
| **Unit** | runtime 类型、session key、schema 校验、feature flag、policy helper | `pnpm run test --testPathPattern=unit` | 零 failure；时序/终态/兼容值断言全通过 |
| **Integration** | Control Plane 生命周期、dispatch + reply projection、translator、session-store | `pnpm run test --testPathPattern=integration` | spawn→done/error→close 稳定；并发取消无竞态 |
| **E2E** | CLI / Bridge 双入口：创建、恢复、取消会话；exec 完成触发持续推送 | 启动 bridge，执行 P4 场景矩阵 S1~S8 | 8 个场景达到"预期结果（可验证）"列描述 |
| **Smoke** | 最小可用路径：启动 bridge → prompt → 收到文本 → cancel | `pnpm run test --testPathPattern=smoke` | 30 秒内完成，无错误退出 |

执行顺序：Unit → Integration → E2E → Smoke。前层失败时后续层不执行。

**必须覆盖的关键断言**

- [ ] 事件时序：`started → progress* → done|error`，终态唯一，不重复投递
- [ ] session key 稳定：相同输入 → 相同 key，跨线程隔离有效
- [ ] cancel 幂等：运行中、终态后多次调用均安全
- [ ] TTL 驱逐：到期后 cache 释放，无脏引用
- [ ] coalesce：连续完成事件下 wake 不丢最后一次通知，无重复 turn
- [ ] 定时 heartbeat 兼容：关闭 event wake 后定时周期不漂移
- [ ] 配置兼容：旧字段别名优先级正确，关闭兼容开关后有明确错误

---

### 回滚预案

#### 分层回退策略

| 回退层级 | 触发条件 | 操作 | 验证方式 |
| --- | --- | --- | --- |
| L1: 关闭 event wake | wake 风暴、heartbeat 停摆（P4-R1/R2） | `acpRuntime.eventWake = false` + 重启 | heartbeat 日志标签变为 `scheduled_heartbeat` 且频次正常 |
| L2: 关闭 argv-first | exec 误拦截、shell 识别错误（P4-R3/R4） | `exec.argvFirst = false` + 重启 | smoke exec 场景通过 |
| L3: 关闭 Bridge 新 translator | ACP 方法映射异常（Gap-B1） | `bridge.newTranslator = false` + 重启 | CLI smoke 场景通过 |
| L4: 全量回退 | 多域同时异常，局部 flag 无效 | `git revert` 到迁移前 commit 或 `migration.enabled = false` | pre-migration smoke 全通过 |

**回退执行检查项**

- [ ] 确认目标回退层级
- [ ] 备份当前运行日志与 session state 快照
- [ ] 执行配置变更或代码回退
- [ ] 重启受影响服务
- [ ] 执行 smoke 测试验证稳定性
- [ ] 记录回退原因与时间到状态文件

---

### 故障排查入口速查

| 故障现象 | 关键日志关键字 | 定位路径 | 对应风险 |
| --- | --- | --- | --- |
| heartbeat 停止触发 | `scheduled_heartbeat` 计数下降；heartbeat interval 配置 | `src/runtime/*` heartbeat scheduler | P4-R2 |
| wake 风暴 / 过度调度 | `event_wake_heartbeat` 触发频次；coalesce 窗口配置 | `src/runtime/*` event queue + coalesce | P4-R1 |
| exec 被误拦截 | `argv consistency check failed`；错误码 | `src/runtime/*` exec validator | P4-R4 |
| session 泄漏 / 脏引用 | `TTL eviction` 日志；cache 清理回调 | `src/acp/*` runtime-cache | P2-T4 |
| ACP 方法返回异常 | `translator mapping error`；method handler | `src/acp/bridge/*` translator | Gap-B1 |
| done/error 重复投递 | `duplicate terminal event`；终态闸门 | reply projection 逻辑 | P4-R5 |
| 配置解析失败 | `schema validation failed`；字段名与默认值 | `src/config/schema/*` | Gap-F1 |
| cancel 后状态不一致 | `cancel idempotency violation` | session manager cancel 路径 | P2-T5 |

## 当前决策

- 先落地文档与阶段计划，再进入实现分派
- 先保守迁移“行为闭环”，再进行性能和结构优化
- 每阶段完成后更新状态与证据，确保长期可追踪

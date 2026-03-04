# OpenClaw -> Mozi 分阶段实施计划

## 阶段总览

| Phase | 名称 | 目标 | 退出标准 |
| --- | --- | --- | --- |
| P0 | 基线冻结与差异盘点 | 建立迁移基线、接口差异清单 | 差异矩阵确认，任务边界冻结 |
| P1 | 协议与类型对齐 | 完成 ACP runtime/types/schema 对齐 | 类型、策略、配置校验通过 |
| P2 | Control Plane 对齐 | 完成会话生命周期与调度闭环 | spawn/run/cancel/status 全链路可测 |
| P3 | Bridge 与入口对齐 | 完成 ACP bridge 与 CLI/commands 对接 | IDE/CLI 双入口可用 |
| P4 | 执行链路与持续推送对齐 | 统一 exec + heartbeat 事件循环 | 问一次可持续跟进输出 |
| P5 | 稳定化与迁移收口 | 文档、测试、回滚、发布准备 | 回归通过，发布门槛达成 |

## P0 基线冻结与差异盘点

### 工作项

- 固化参考源（OpenClaw 版本、关键模块）
- 建立能力差异矩阵（已有/缺失/部分实现）
- 定义迁移边界（in scope / out of scope）

### 产物

- 迁移蓝图（已产出）
- 差异矩阵文档
- 阶段拆分与依赖图

### 退出标准

- 关键干系人确认范围与优先级
- Phase 任务可直接分派执行

## P1 协议与类型对齐

### 目标（与蓝图映射）

- 对齐蓝图 `Gap-R1/R2`：统一 `AcpRuntime`、`AcpRuntimeEvent` 与错误归因口径。
- 对齐蓝图 `Gap-F1/F2`：收敛配置 schema、默认值与兼容开关策略。
- 对齐蓝图 `Gap-C2` 前置条件：固定 session identity / policy helper 的命名与约束。

### 可分派任务清单（P1）

| Task | 任务描述 | Blueprint 映射 | 依赖 | 验证方式（Definition of Done） |
| --- | --- | --- | --- | --- |
| P1-T1 | ACP runtime 类型对齐：收敛 `AcpRuntime`/`AcpRuntimeEvent`/错误模型类型定义 | Gap-R1 | P0 差异矩阵冻结 | `pnpm run test` 覆盖 runtime 类型相关单测；补充 done/error 时序断言 |
| P1-T2 | runtime registry 元数据对齐：统一能力探测字段与注册约束 | Gap-R2 | P1-T1 | registry 选择策略测试通过；配置缺失/冲突场景有明确错误断言 |
| P1-T3 | session identity / policy helper 对齐：统一 session key 规则与 helper 接口 | Gap-C2（前置） | P1-T1 | session key 规范测试通过；跨线程/并发路由策略断言稳定 |
| P1-T4 | 配置 schema 收敛：迁移字段、默认值、校验规则集中到 schema 层 | Gap-F1 | P1-T1, P1-T3 | schema 解析与默认值测试通过；文档字段与 schema 一致 |
| P1-T5 | 兼容开关策略落地：新增/归一 feature flags 与回退路径 | Gap-F2 | P1-T4 | 新旧配置兼容测试通过；开关启停行为可复现；回退路径明确 |
| P1-T6 | P1 验证收口：类型/策略/配置跨模块回归测试与证据归档 | Gap-R1/R2/F1/F2 | P1-T1~P1-T5 | `pnpm run test` 全通过；输出 P1 验收记录（测试项、结果、已知风险） |

### 配置兼容与 Feature Flag 策略

1. **兼容优先级**
   - 先兼容旧字段（alias/映射），再引导新字段成为主路径。
   - 默认行为保持 Mozi 现状，新增能力通过显式开关启用。
2. **开关分层**
   - `compat` 层：旧行为保持开关（用于平滑迁移与快速回退）。
   - `acpRuntime` 层：事件语义、错误模型、registry 选择逻辑开关。
   - `policy` 层：session identity / policy helper 新规则开关。
3. **启用节奏（建议）**
   - P1：默认关闭新语义，仅在测试/灰度开启。
   - P2：Control Plane 接入后，按模块逐步默认开启。
   - P3+：稳定后移除临时兼容路径，保留最小回退开关。
4. **回退策略**
   - 每个开关需对应可回退的旧路径。
   - 禁止“不可逆配置迁移”直切；需保留一次版本窗口的双读/映射能力。

### 类型/策略测试建议清单

- [ ] `AcpRuntimeEvent` 时序断言：`started -> progress* -> done|error` 且终态唯一。
- [ ] 错误模型断言：可区分配置错误、策略拒绝、运行时异常。
- [ ] runtime registry 选择断言：能力探测字段一致且冲突可预期。
- [ ] session key 稳定性断言：同输入生成同 key，跨线程隔离有效。
- [ ] policy helper 断言：允许/拒绝路径均有明确原因码与消息。
- [ ] schema 默认值断言：缺省配置行为与文档一致。
- [ ] 配置兼容断言：旧字段/新字段并存时优先级明确且可回退。
- [ ] feature flag 断言：开关开/关下行为差异符合预期。

### 产物

- P1 可分派任务清单（含依赖与验证方式）
- `src/acp` 类型与注册层对齐变更（后续任务执行）
- `src/config/schema` 迁移字段与兼容开关策略（后续任务执行）
- 类型/策略/配置测试建议清单

### 退出标准

- P1-T1 ~ P1-T6 全部完成并有测试证据
- 类型检查与 `pnpm run test` 通过
- 配置兼容路径与回退路径经验证可用
- 与蓝图映射（Gap-R1/R2/F1/F2、Gap-C2 前置）保持一致

## P2 Control Plane 对齐

### 目标（与蓝图/P1 输出映射）

- 承接 P1 输出（统一 `AcpRuntime`/事件语义/schema 开关），完成 Control Plane 会话生命周期闭环。
- 对齐蓝图中 Control Plane 路径：`session manager + runtime cache + dispatch/reply projection`。
- 为 P3 Bridge 提供可复用的会话与取消语义基线。

### 可分派任务清单（P2）

| Task | 任务描述 | 输入前提（P1 输出） | 依赖 | 验证方式（Definition of Done） |
| --- | --- | --- | --- | --- |
| P2-T1 | Session Manager 骨架落地：定义 `ensureSession/runTurn/cancel/close/getStatus` 责任边界与状态机 | `AcpRuntime` 接口、错误模型、session key 规则已统一 | P1-T1, P1-T3 | 生命周期状态迁移测试通过；非法状态迁移有明确错误断言 |
| P2-T2 | `ensureSession` + thread/session 路由：同 key 复用、不同 key 隔离、并发保护 | session identity 规则稳定 | P2-T1 | 并发 ensure 场景下无重复初始化；thread 绑定路由测试通过 |
| P2-T3 | `runTurn` dispatch 接入：将消息派发到 runtime，并标准化事件出站 | runtime event 语义已固定 | P2-T1, P1-T1 | `started -> progress* -> done/error` 时序测试通过；dispatch 失败归因可观测 |
| P2-T4 | runtime-cache + TTL 驱逐：缓存句柄复用、过期回收、关闭清理 | schema 中 runtime TTL 配置可解析 | P1-T4, P2-T2 | TTL 到期自动驱逐测试通过；关闭后缓存项释放、无脏引用 |
| P2-T5 | 失败恢复与取消语义：`cancel/close` 幂等、失败 spawn 清理、重试边界 | 错误模型与兼容开关可用 | P2-T1, P2-T3, P2-T4 | cancel 多次调用不破坏状态；spawn 失败后 session/cache/binding 一致回滚 |
| P2-T6 | reply projection 对齐：运行时事件投影为统一回复流（文本、状态、错误） | 事件模型与策略开关稳定 | P2-T3 | projection 输出格式测试通过；终态唯一且与 runtime 终态一致 |
| P2-T7 | P2 集成验收：`spawn -> run -> done/error -> close` 全链路回归与证据归档 | P2-T1~T6 完成 | P2-T1~P2-T6 | `pnpm run test` 通过；输出 P2 验收记录（并发、取消、恢复、已知风险） |

### 关键集成点定义（P2）

1. **Dispatch 集成点**
   - 输入：线程消息/任务请求 + session resolution 结果。
   - 处理：`runTurn` 调 runtime，统一错误归因与重试/不可重试信号。
   - 输出：标准化 runtime event 流。
   - 验证：dispatch 成功、策略拒绝、runtime 异常三类路径均可断言。

2. **Reply Projection 集成点**
   - 输入：runtime event（text/status/tool_call/done/error）。
   - 处理：投影为对外回复事件，保持终态唯一、顺序稳定。
   - 输出：可被上层消息通道消费的 reply 流。
   - 验证：done/error 互斥；text_delta 合并策略在阈值内可复现。

### 失败恢复与取消语义测试建议（P2）

- [ ] `cancel` 在运行中调用：运行停止且终态为已取消（或等价 stopReason）。
- [ ] `cancel` 在终态后调用：幂等返回，不抛出未分类错误。
- [ ] `close` 触发后：runtime handle、cache、thread binding 同步清理。
- [ ] spawn 初始化中失败：回滚 sessions patch / binding / cache 残留。
- [ ] runtime 崩溃或超时：错误事件含 code/retryable，并可触发受控恢复路径。
- [ ] 并发取消与完成竞态：终态唯一，且不会重复投递 done/error。

### 产物

- P2 可分派任务清单（含依赖与 DoD）
- Session Manager / runtime-cache / dispatch / reply projection 对齐实施说明
- 失败恢复与取消语义测试建议清单

### 退出标准

- P2-T1 ~ P2-T7 全部完成并有测试证据
- `spawn -> run -> done/error -> close` 闭环稳定
- 并发与取消场景可复现通过

## P3 Bridge 与入口对齐

### 目标（与蓝图/P2 输出映射）

- 在 P2 生命周期与取消语义稳定后，对齐 ACP Bridge 的 translator/session-store/commands。
- 打通 IDE/CLI 双入口，确保命令语义与 Control Plane 行为一致。

### 可分派任务清单（P3）

| Task | 任务描述 | 输入前提（P2 输出） | 依赖 | 验证方式（Definition of Done） |
| --- | --- | --- | --- | --- |
| P3-T1 | Bridge server 入口对齐：启动参数、stdio NDJSON 生命周期、健康检查 | P2 会话生命周期可复用 | P2-T7 | bridge 可启动/关闭；启动失败信息可诊断 |
| P3-T2 | Translator 对齐：ACP 方法到 mozi 会话/turn/cancel 的映射（new/load/prompt/cancel/list） | dispatch/reply projection 契约稳定 | P2-T3, P2-T6 | translator 单测覆盖主要 ACP 方法；错误映射一致 |
| P3-T3 | Session-store 落地：内存会话索引、TTL、恢复策略与 session key 映射 | runtime-cache 语义明确 | P2-T4 | load/list/new 一致性测试通过；TTL 过期行为可断言 |
| P3-T4 | Commands 对齐：CLI `mozibot acp` 与 slash commands 的参数/返回语义统一 | cancel/close 语义稳定 | P2-T5 | CLI 与 slash 命令同场景输出一致；参数校验错误可预期 |
| P3-T5 | Event mapper/输出收敛：bridge 输出与 Control Plane reply projection 口径一致 | P2 reply projection 已稳定 | P3-T2, P2-T6 | 文本/状态/错误事件在 IDE 与 CLI 侧表现一致 |
| P3-T6 | P3 集成验收：IDE/CLI 创建、恢复、取消会话全链路回归 | P3-T1~T5 完成 | P3-T1~P3-T5 | `pnpm run test` 通过；输出 P3 验收记录（入口一致性、恢复、取消） |

### 关键集成点定义（P3）

1. **Translator 集成点（Bridge ↔ Control Plane）**
   - 输入：ACP 请求（initialize/newSession/loadSession/prompt/cancel/...）。
   - 处理：映射为内部 session manager 与 dispatch 调用。
   - 输出：ACP 兼容响应 + 流式事件。
   - 验证：同一请求在 Bridge/CLI 下得到一致终态与错误语义。

2. **Session-store 集成点**
   - 输入：session 创建/恢复/过期事件。
   - 处理：维护 ACP sessionId 与内部 session key 映射。
   - 输出：`loadSession`/`listSessions` 可见一致视图。
   - 验证：过期、恢复、并发访问下映射无悬挂条目。

3. **CLI/Commands 集成点**
   - 输入：`mozibot acp` 子命令与 slash command 参数。
   - 处理：统一参数校验、策略检查、错误文案分层（用户可读/诊断可读）。
   - 输出：一致的启动、取消、状态查询行为。
   - 验证：同一场景下 CLI 与 slash command 行为对齐。

### 失败恢复与取消语义测试建议（P3）

- [ ] `prompt` 进行中触发 `cancel`：Bridge 侧收到终止回执且不再下发增量。
- [ ] `loadSession` 命中过期 session：返回可识别错误并给出恢复建议路径。
- [ ] CLI 启动 bridge 后异常退出：session-store 清理与下次启动恢复策略明确。
- [ ] translator 映射异常：不泄漏内部栈细节，保留诊断 code。
- [ ] IDE 与 CLI 并发操作同 session：取消与终态回传保持一致。

### 产物

- P3 可分派任务清单（含依赖与 DoD）
- translator / session-store / commands 集成点定义
- Bridge 失败恢复与取消语义测试建议清单

### 退出标准

- P3-T1 ~ P3-T6 全部完成并有测试证据
- ACP 客户端可创建/恢复/取消会话
- CLI 与 slash commands 行为一致

## P4 执行链路与持续推送对齐

### 目标（与前置阶段输出映射）

- 承接 P1 的配置/schema 与 feature flag 兼容策略，保证 exec 新语义可灰度启停。
- 承接 P2 的 session 生命周期、dispatch/reply projection 与取消语义，保证持续推送链路可复用既有控制面能力。
- 对齐 P3 的 bridge/CLI/commands 入口语义，确保同一持续推送场景在不同入口可复现。
- 收敛两条专项对齐成果：
  - Exec argv 对齐（`argv first + shell wrapper 检测 + rawCommand/argv 一致性校验`）
  - Heartbeat wake 对齐（`system event queue + requestHeartbeatNow + coalesce`）

### P4 统一验收场景矩阵（可复现）

| 场景 ID | 验收场景 | 前置条件 | 操作步骤（可复现） | 预期结果（可验证） | 关联能力 |
| --- | --- | --- | --- | --- | --- |
| P4-S1 | argv 直连执行（非 shell） | 开启 P4 主路径开关；session 已建立 | 1) 发起 exec：`["echo", "hello"]` 2) 观察 supervisor spawn 参数 3) 观察事件流 | 直接 spawn，无 shell wrapper；事件序列满足 `started -> progress* -> done` | argv first、event projection |
| P4-S2 | shell wrapper 执行路径 | 同 S1 | 1) 发起 exec：`["bash", "-lc", "echo hi && whoami"]` 2) 观察 shell 上下文字段 3) 观察输出 | shell wrapper 被识别；`shellCommand` 非空；输出与 shell 语义一致 | wrapper 检测、shell 上下文标识 |
| P4-S3 | rawCommand/argv 防注入校验 | 启用一致性校验 | 1) 构造 rawCommand 与 argv 不一致输入 2) 发起执行 | 执行被拒绝；返回可诊断错误码；不落地 spawn | 一致性校验、安全防护 |
| P4-S4 | exec 完成触发持续推送闭环 | system event queue 与 wake 已启用 | 1) 发起会触发异步结果的 exec 2) 等待 `exec.finished` 3) 观察 system event 入队与 heartbeat 触发 4) 观察后续 agent turn | `exec.finished -> enqueueSystemEvent -> requestHeartbeatNow -> 新 turn` 链路完整；用户收到后续推送 | event queue、heartbeat wake |
| P4-S5 | 去抖与并发抑制 | coalesce/active-session 保护开启 | 1) 短时间内触发多次 exec 完成事件 2) 观察 heartbeat 调度 | wake 请求被合并；同 session 无并发重复 turn；无重复终态事件 | coalesce、防并发 |
| P4-S6 | 取消与终态竞态 | P2 cancel/close 语义已稳定 | 1) 执行中触发 cancel 2) 同时模拟接近完成竞态 3) 观察终态 | 终态唯一（cancel 或 done/error 之一）；无重复投递；资源正确清理 | cancel 幂等、终态唯一 |
| P4-S7 | 跨入口一致性（CLI/Bridge） | P3 translator/commands 已对齐 | 1) 在 CLI 路径执行 S4 2) 在 Bridge 路径执行 S4 3) 对比外显行为 | 两入口在触发时机、事件顺序、终态语义一致 | 入口一致性、bridge 对齐 |
| P4-S8 | 定时 heartbeat 不回归 | 保持原有 heartbeat interval 配置 | 1) 不触发 system event 2) 仅观察定时心跳 3) 再触发 wake 场景 | 未触发 event 时仍按原定时策略执行；触发 wake 时只提前唤醒，不破坏后续周期 | 兼容旧逻辑、调度稳定性 |

### 回归测试建议（重点：不破坏既有 heartbeat 定时逻辑）

1. **定时逻辑保真回归（必须）**
   - [ ] 在关闭/未触发 wake 条件下，heartbeat 触发间隔与 P4 前基线一致。
   - [ ] wake 触发后，不应导致定时任务丢失、永久漂移或重复注册。
2. **事件驱动增强回归（新增）**
   - [ ] `exec.finished` 必然触发 system event 入队与一次可观测 wake 请求。
   - [ ] 连续完成事件触发下，coalesce 生效且不会吞掉最后一次有效通知。
3. **会话隔离与并发回归**
   - [ ] 不同 sessionKey 的 wake 不互相阻塞；同 sessionKey 严格串行。
   - [ ] active session 期间重复 wake 不产生重入执行。
4. **失败与恢复回归**
   - [ ] wake handler 失败后可恢复，不影响后续定时 heartbeat。
   - [ ] system event 消费失败保留可重试线索，避免 silent drop。
5. **可观测性回归**
   - [ ] 日志/指标可区分 `scheduled_heartbeat` 与 `event_wake_heartbeat` 来源。
   - [ ] 可通过测试断言验证触发原因、次数与终态一致性。

### 风险项与回退策略

| 风险项 | 触发信号 | 影响 | 缓解措施 | 回退策略 |
| --- | --- | --- | --- | --- |
| R1: wake 风暴导致过度调度 | 心跳触发频次异常升高、队列堆积 | 资源抖动、响应不稳定 | coalesce、session active 锁、限流阈值 | 关闭 event wake 开关，仅保留 scheduled heartbeat |
| R2: 定时逻辑被事件逻辑覆盖 | 定时心跳次数明显下降或停摆 | 旧能力回归失败 | 调度来源分离、双路径监控 | 回退到 P4 前调度实现，保留事件入队但不触发立即 wake |
| R3: argv/shell 识别错误 | shellCommand 标识异常、执行路径偏差 | 执行失败或安全风险 | 增加 wrapper 识别与一致性校验测试 | 通过 feature flag 切回旧 command string 路径 |
| R4: 校验过严导致误拒绝 | 合法命令被拦截率上升 | 可用性下降 | 白名单化例外模式与错误码分级 | 降级为告警模式（记录不拦截），后续修正规则 |
| R5: 终态竞态导致重复推送 | done/error/cancel 重复投递 | 用户体验混乱、状态不一致 | 终态唯一闸门、幂等投递键 | 回退到单次问答路径并禁用连续推送 |

**回退执行顺序（建议）**

1. 先关闭 `event wake`，确认系统回到纯定时 heartbeat 稳定态。
2. 若问题仍在，关闭 `argv first / wrapper` 新路径，回到旧 exec 解析路径。
3. 保留日志与指标采样，完成问题定位后按开关分批恢复（先灰度后全量）。

### P4 产物

- P4 统一验收场景矩阵（含复现步骤、可验证结果、能力映射）
- 回归测试建议清单（覆盖 scheduled heartbeat 兼容与 event wake 增强）
- 风险项与回退策略（含触发信号、缓解、分层回退顺序）

### P4 退出标准

- P4-S1 ~ P4-S8 关键场景全部可复现并通过
- 执行完成后可自动触发后续 agent turn
- 不破坏现有 heartbeat 定时逻辑（基线回归通过）
- 与 P1/P2/P3 的依赖链路与开关策略可追踪

## P5 稳定化与迁移收口

### 目标

收敛 P1-P4 所有交付成果，完成回归验证、文档定稿与发布门禁达成，形成可发布的稳定态。

---

### P5 发布检查清单（Go/No-Go 门禁）

以下各项必须全部标记 `[x]` 方可触发发布动作。

#### 门禁 G1 — 测试覆盖（强制）

- [ ] `pnpm run test` 全量通过，零 failure，零 skip（未经批准）
- [ ] 回归矩阵（见下节）全部层级通过
- [ ] P4 验收场景矩阵 P4-S1~P4-S8 全部可复现并有截图/日志记录
- [ ] 无因迁移引入的新 TypeScript 编译错误

#### 门禁 G2 — 功能完整性（强制）

- [ ] ACP Control Plane 全链路：`spawn → run → done/error → close` 可在 CI 中稳定复现
- [ ] ACP Bridge：initialize / newSession / loadSession / prompt / cancel / status 全方法覆盖
- [ ] CLI 与 slash commands 同场景输出一致（P3-T6 验收记录存在）
- [ ] exec 完成后持续推送闭环可触发（P4-S4 场景稳定）
- [ ] 配置兼容：旧字段与新字段并存时行为符合 P1 定义的优先级规则

#### 门禁 G3 — 回滚可操作（强制）

- [ ] 每个 feature flag 有对应的关闭路径且经过验证（参见"回滚预案"节）
- [ ] 回滚至 P4 前基线的步骤文档已完成且可执行（无额外代码变更）
- [ ] 灾难场景（runtime 崩溃、session 泄漏）对应排障入口已文档化

#### 门禁 G4 — 文档与可观测性（强制）

- [ ] `docs/CONFIGURATION_GUIDE.md` 与实际 schema 字段一致
- [ ] `docs/OPENCLAW_TO_MOZI_MIGRATION_BLUEPRINT.md` 验收总标准核查通过
- [ ] 日志可区分 `scheduled_heartbeat` 与 `event_wake_heartbeat` 来源
- [ ] 运维手册包含排障命令、关键日志关键字、指标告警阈值

#### 门禁 G5 — 风险关闭（强制）

- [ ] P4 风险矩阵 R1~R5 各项均已标注"已缓解"或"已接受（附原因）"
- [ ] 蓝图中 Gap-R1/R2/C1/C2/B1/B2/E1/E2/F1/F2 各项已标注 done 或显式降级决策
- [ ] 无遗留 Critical/High 级别未闭合 issue

#### 门禁 G6 — 发布操作准备（强制）

- [ ] 迁移状态文件 `.claude/dispatch/runs/openclaw-mozi-migration-20260303T000000/state.json` 已更新为 `completed`
- [ ] 版本 tag / changelog 已准备（含本次迁移范围说明）
- [ ] 至少一名非作者 reviewer 完成代码 review 并 approve

---

### 回归矩阵

| 层级 | 范围 | 执行命令 | 通过标准 | 负责方 |
| --- | --- | --- | --- | --- |
| **Unit** | runtime 类型、session key、schema 校验、feature flag、policy helper | `pnpm run test --testPathPattern=unit` | 零 failure；核心断言项（时序、终态唯一、兼容值）全通过 | 开发 |
| **Integration** | Control Plane 生命周期、dispatch + reply projection、translator 映射、session-store | `pnpm run test --testPathPattern=integration` | spawn→run→done/error→close 完整流通过；并发取消无竞态 | 开发 |
| **E2E** | CLI 与 Bridge 双入口创建/恢复/取消会话；exec 完成触发持续推送 | 本地或 CI 启动 bridge，执行 P4 场景矩阵 S1~S8 | 8 个场景全部达到"预期结果（可验证）"列描述 | QA / 开发 |
| **Smoke** | 最小可用路径：启动 bridge → 发起 prompt → 收到文本回复 → cancel | `pnpm run test --testPathPattern=smoke`（或等价脚本） | 30 秒内完成，无错误退出 | 发布前人工 + CI |

回归矩阵执行顺序：Unit → Integration → E2E → Smoke。前一层失败时后续层不需要执行。

**关键断言项清单（必须覆盖）**

- [ ] `AcpRuntimeEvent` 时序：`started → progress* → done|error`，终态唯一，不可重复投递
- [ ] session key 稳定性：相同输入产出相同 key，跨线程隔离有效
- [ ] cancel 幂等：运行中、终态后多次调用均安全
- [ ] TTL 驱逐：到期后 cache 项释放，无脏引用
- [ ] coalesce：连续完成事件下 wake 不丢最后一次有效通知，无重复 turn
- [ ] 定时 heartbeat 兼容：关闭 event wake 后定时周期不漂移
- [ ] 配置兼容：旧字段别名优先级正确，关闭兼容开关后有明确错误提示

---

### 回滚预案

#### 分层回退顺序

1. **关闭 event wake**（Feature Flag: `acpRuntime.eventWake = false`）
   - 触发条件：heartbeat 频次异常、队列堆积、wake 风暴（对应 P4 风险 R1/R2）
   - 操作：修改配置关闭开关，重启服务；系统回到纯定时 heartbeat 稳定态
   - 验证：观察 heartbeat 日志来源标签变为 `scheduled_heartbeat` 且频次正常

2. **关闭 argv-first / shell wrapper 新路径**（Feature Flag: `exec.argvFirst = false`）
   - 触发条件：exec 路径识别错误、合法命令被误拦截（对应 P4 风险 R3/R4）
   - 操作：关闭开关，回到旧 command string exec 解析路径
   - 验证：执行 smoke 场景确认 exec 可正常完成

3. **关闭 Bridge 新方法实现**（Feature Flag: `bridge.newTranslator = false`）
   - 触发条件：ACP 方法映射错误、session-store 数据不一致（对应蓝图风险 R2）
   - 操作：关闭开关，bridge translator 回退到 P3 前实现
   - 验证：CLI smoke 场景通过

4. **全量回退到迁移前基线**
   - 触发条件：上述局部回退无法稳定，多域同时异常
   - 操作：`git revert` 到迁移前 commit，或通过主 feature flag `migration.enabled = false` 全局关闭迁移路径
   - 验证：所有 pre-migration smoke 场景通过

#### 回退执行检查项

- [ ] 确认目标回退层级（局部 flag / 全量 revert）
- [ ] 备份当前运行日志与 session state 快照
- [ ] 执行配置变更或代码回退
- [ ] 重启受影响服务（bridge / runtime host）
- [ ] 执行 smoke 测试验证稳定性
- [ ] 更新状态文件记录回退原因与时间

---

### 故障排查入口

| 故障现象 | 排查命令 / 关键字 | 定位路径 | 对应风险项 |
| --- | --- | --- | --- |
| heartbeat 停止触发 | 日志搜索 `scheduled_heartbeat` 计数；检查 heartbeat interval 配置 | `src/runtime/*` heartbeat scheduler | P4-R2 |
| wake 风暴 / 过度调度 | 日志搜索 `event_wake_heartbeat` 触发频次；检查 coalesce 窗口配置 | `src/runtime/*` event queue + coalesce | P4-R1 |
| exec 被误拦截 | 日志搜索 `argv consistency check failed`；输出错误码 | `src/runtime/*` exec validator | P4-R4 |
| session 泄漏 / 脏引用 | 搜索 `TTL eviction` 日志；检查 cache 清理回调 | `src/acp/*` runtime-cache | P2-T4 DoD |
| ACP 方法返回异常 | 搜索 `translator mapping error`；检查 ACP method handler | `src/acp/bridge/*` translator | Gap-B1 |
| done/error 重复投递 | 搜索 `duplicate terminal event`；检查终态闸门逻辑 | reply projection + P4-S6 场景 | P4-R5 |
| 配置解析失败 | 搜索 `schema validation failed`；检查字段名与默认值 | `src/config/schema/*` | Gap-F1 |
| cancel 后状态不一致 | 搜索 `cancel idempotency violation`；重放 P2-T5 场景 | session manager cancel 路径 | P2-T5 DoD |

---

### Telegram / Discord 专项补齐计划（新增）

| Task | 任务描述 | 依赖 | 验证方式（DoD） |
| --- | --- | --- | --- |
| TD-T1 | 跨渠道语义一致性测试：`silent/replyTo/chunk/status reactions` 在 Telegram/Discord 表现一致 | P2/P3 已完成 | 新增集成测试通过，差异项显式记录 |
| TD-T2 | Discord roadmap 能力补齐第一批：components/buttons + polls + webhook send | TD-T1 | 已完成：对应功能测试通过，webhook 失败路径可诊断；URL media 护栏已在 TD-T3 完成 |
| TD-T3 | Discord 媒体 URL 上传与护栏（下载、大小限制、失败降级） | TD-T2 | 已完成：URL media 上传/超限降级/下载失败降级测试通过 |
| TD-T4 | Forum/media 线程自动创建与权限诊断增强 | TD-T2 | 已完成：线程创建成功/权限失败两条路径可复现并有测试覆盖 |
| TD-T5 | Telegram/Discord 运维 runbook 补齐（排障命令、日志关键字、SLO） | TD-T1~TD-T4 | 已完成：runbook 已补齐并落地 `docs/TELEGRAM_DISCORD_OPS_RUNBOOK.md` |
| TD-T6 | Telegram/Discord CLI/slash parity 语义矩阵（同输入同终态） | TD-T1~TD-T4 | 已完成：新增 parser/inbound-flow/discord/telegram parity 测试矩阵并通过；覆盖 `/help /status /models /skills /new /reset /stop /switch`、aliases(`/model /id /t /reason`)、unknown slash、前后空白 |

### P5 可分派任务清单

| Task | 任务描述 | 依赖 | 验证方式（DoD） |
| --- | --- | --- | --- |
| P5-T1 | 回归矩阵执行：Unit + Integration + E2E + Smoke 全部层级通过并归档结果 | P4-T 全部完成 | 回归报告含通过率、失败列表（空）、执行时间 |
| P5-T2 | 发布门禁核查：G1~G6 逐项检查，填写检查清单，未通过项提出 issue | P5-T1 | 检查清单 100% 完成，无未闭合 Critical 项 |
| P5-T3 | 文档收口：配置指南、运维手册、蓝图验收总标准核查 | P5-T2 | `CONFIGURATION_GUIDE.md` 与 schema 一致；排障入口文档已更新 |
| P5-T4 | 风险关闭：蓝图 Gap 矩阵、P4 风险矩阵逐项标注 done/降级/接受 | P5-T2 | 风险矩阵无空白项 |
| P5-T5 | 状态文件更新与版本准备：state.json 置为 completed，准备 changelog | P5-T2, P5-T3, P5-T4 | state.json status = "completed"；changelog 存在且描述迁移范围 |

### 产物

- P5 发布检查清单（G1~G6，含签字确认）
- 回归矩阵执行报告（含各层级通过记录）
- 回滚预案（分层回退步骤 + 执行检查项）
- 故障排查入口速查表
- 最终迁移状态文件（completed）

### 退出标准

- 回归矩阵 Unit / Integration / E2E / Smoke 全部通过
- 发布门禁 G1~G6 全部打勾，无未闭合 Critical 项
- 回滚预案经验证可操作（至少 flag 层回退路径人工验证一次）
- 蓝图 Gap 矩阵、P4 风险矩阵全部有明确结论
- 迁移状态更新为 `completed`

## 依赖关系（简化）

- P1 <- P0
- P2 <- P1
- P3 <- P2
- P4 <- P2
- P5 <- P3, P4

## 建议执行顺序

1. 先推进 P0/P1，锁定协议与配置基线
2. 并行推进 P2 与部分 P4（基础能力已具备时）
3. 收敛至 P3，再统一在 P5 做全链路验收与收口

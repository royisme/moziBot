# ACP Session 升级为真正 Detached Task Runtime 最终方案

## 文档目标

本文档定义 moziBot 中 ACP session 的最终升级方案：将其从“可初始化、可执行 turn 的 ACP 会话”升级为“具备宿主级 detached task lifecycle、可靠 completion announce、可重启补偿”的真正 detached task runtime。

本文档为**最终实施版**，目标是让工程实现不再依赖二次解释。

---

## 一、问题定义

当前系统里已经存在三块相互独立但尚未闭环的能力：

1. **ACP control plane** 能初始化并执行 ACP turn
   入口与执行边界位于：
   - `src/agents/tools/sessions-acp.ts:75`
   - `src/acp/control-plane/manager.ts:217`

2. **Host detached run lifecycle** 能管理异步任务并在 terminal 时回调
   入口位于：
   - `src/runtime/host/message-handler.ts:646`

3. **Subagent completion announce + restart reconcile** 已具备完整持久化与补偿机制
   关键实现位于：
   - `src/runtime/host/sessions/subagent-registry.ts:103`
   - `src/runtime/host/sessions/subagent-registry.ts:235`

### 当前缺陷

ACP session 当前并不是宿主语义上的 detached task runtime，主要缺口是：

- ACP turn terminal 结果没有统一接入 host detached terminal callback 语义
- ACP completion 没有进入持久化 announce/reconcile 机制
- 父会话无法可靠感知 ACP task 的完成、失败、超时或中止
- host 重启后，ACP 已终态但未通知的任务没有补偿路径

### 结论

这不是“ACP 完全没有 runtime”，而是**ACP 没有被接入现有 detached task 闭环**。

因此，本次改造的目标不是新造一套平行系统，而是将 ACP 正确接入现有宿主 lifecycle、持久化与 announce 体系。

---

## 二、架构原则

本方案遵守以下原则：

### 1. 优先复用，禁止重复建设生命周期系统

优先级如下：

1. 复用现有 host detached run lifecycle
2. 复用现有 `EnhancedSubAgentRegistry` 的持久化/去重/reconcile 能力
3. 仅在无法合理抽象时，才新增 ACP 专用 registry 或 announce helper

### 2. Terminal 汇聚必须发生在 host / control-plane 边界

禁止把 completion announce 逻辑下沉到：

- ACP backend
- ACP runtime adapter
- channel plugin

原因：

- backend 只负责 runtime 事件，不负责产品通知语义
- announce 是宿主级产品行为，不是 ACP backend 行为
- 只有 host/control-plane 边界才知道父会话、任务归属、重试与去重策略

### 3. 初始化与执行边界必须分离

- `sessions-acp.ts` 只负责**初始化 ACP session**
- `AcpSessionManager.runTurn(...)` 负责**执行 turn 并产生 terminal 信号**
- detached lifecycle / announce 负责**宿主级任务完成语义**

不能把初始化入口误当成 terminal 边界。

### 4. ACP 不应伪装成 subagent

即便底层复用 `EnhancedSubAgentRegistry`，在产品语义与 metadata 契约层面，也应保留 ACP 的任务类型身份。

---

## 三、现有真实调用链

### 3.1 ACP 初始化链路

`src/agents/tools/sessions-acp.ts:75` 中的 `initializeAcpSubAgent(...)` 当前负责：

- ACP policy 校验
- 解析 backend / agent / mode / runtimeOptions
- 写入 session ACP meta
- 调用 `AcpSessionManager.ensureSession(...)`
- 回写 session metadata

这一步只保证“ACP session 已初始化”，**不代表 ACP detached task 已运行完成**。

### 3.2 ACP turn 执行链路

`src/acp/control-plane/manager.ts:217` 中的 `runTurn(...)` 是 ACP turn 的真正执行边界。

关键事实：

- runtime event 在 `for await (const event of runtime.runTurn(turnInput))` 中被消费：`src/acp/control-plane/manager.ts:310`
- terminal event 在这里被观察到（`done` / `error`）
- 这里是 ACP terminal 语义最接近真实 runtime 的位置

### 3.3 Host detached lifecycle 链路

`src/runtime/host/message-handler.ts:646` 中的 `startDetachedRun(...)` 已提供：

- detached run 创建
- run lifecycle 状态管理
- `onTerminal` callback 挂载
- terminal 时统一触发回调
- 最终清理 lifecycle

这说明 moziBot 宿主层已经具备 detached task 的通用宿主能力。

### 3.4 Subagent announce / reconcile 链路

`src/runtime/host/sessions/subagent-registry.ts` 已提供：

- register / markStarted / setTerminal
- terminal announce 去重
- announce 失败后保留终态
- host 重启后 `reconcileOrphanedRuns()` 补偿未 announce 终态任务

这是当前系统里最成熟、最接近目标能力的组件。

---

## 四、最终架构决策

## 决策 A：ACP detached task 必须接入现有 host detached terminal callback

### 决策内容

ACP detached task 的 terminal 结果，必须最终以与 `startDetachedRun(... onTerminal ...)` 一致的宿主语义对外暴露。

### 原因

- detached task 的“完成一次且仅一次”语义应由 host 保证
- 父会话通知、重试、去重都属于宿主责任
- 这能避免 ACP 自己再维护一套并行 terminal 状态机

### 落地要求

- ACP 执行链路必须向 host 交付标准 terminal 结果
- host 侧只能从一个统一 terminal 边界触发持久化和 announce
- 不允许 ACP runtime backend 自己直接给父会话发通知

---

## 决策 B：优先扩展 `EnhancedSubAgentRegistry`，不先创建 `AcpRunRegistry`

### 决策内容

第一阶段实现中，优先把 `EnhancedSubAgentRegistry` 提升为**通用 detached task registry**，而不是新增 `AcpRunRegistry`。

### 具体做法

在现有 record 上引入任务类型字段，例如：

```ts
kind: "subagent" | "acp"
```

并在必要时补充最少量的 ACP 专属字段，但保留以下能力复用：

- 持久化
- terminal 去重
- announce 成功标记
- cleanup 删除策略
- host restart reconcile

### 原因

如果现在直接新建 `AcpRunRegistry`，会出现三套状态：

1. host detached lifecycle
2. subagent registry
3. acp registry

这会造成：

- terminal 状态分裂
- 重启补偿逻辑分叉
- announce 去重策略重复
- 测试矩阵膨胀

### 允许例外

只有当实现过程中确认以下任一事实成立，才允许拆出独立 `AcpRunRegistry`：

- ACP record 结构与 subagent record 冲突严重
- ACP cleanup/reconcile 规则显著不同
- ACP announce 契约无法与 detached task 通用模型共存

在没有证据前，不允许先拆。

---

## 决策 C：announce helper 应从“subagent 专用”提升为“detached task announce”

### 决策内容

现有 `announceSubagentResult(...)` 不应继续作为 ACP completion 的最终语义接口。

最终应将其抽象为通用 detached task announce 层，再由：

- subagent
- ACP task

分别映射到不同的显示文案与 metadata。

### 原因

如果 ACP 直接沿用：

- `subagentRunId`
- `subagentChildKey`
- `subagentStatus`

则 ACP 在产品层面会被伪装成 subagent，造成语义污染。

### 设计要求

推荐抽象为通用字段，例如：

- `taskRunId`
- `taskChildKey`
- `taskStatus`
- `taskKind`

其中：

- `taskKind = "subagent" | "acp"`

如短期兼容需要，可临时保留旧字段给 subagent，但 ACP 不应新增写入 subagent 专用字段。

---

## 决策 D：ACP terminal 映射必须在单点定义

### 决策内容

ACP runtime terminal event 到宿主 detached terminal 状态的映射，只允许在一个地方定义。

### 标准映射

- ACP `done` → `completed`
- ACP `error` → `failed`
- host 主动取消 / 中止 → `aborted`
- timeout → `timeout`

### 原因

如果 host、ACP manager、测试文件各自复制映射规则，会出现：

- terminal 判定不一致
- announce 文案与持久化状态不一致
- retry/reconcile 结果不一致

### 落地要求

新增一个明确的 terminal 归一化函数，由：

- ACP control-plane
- host detached callback
- tests

共同复用。

---

## 五、实施方案

## Phase 1：打通 ACP terminal → host detached callback

### 目标

让 ACP detached task 具备统一 terminal 边界。

### 必做事项

1. 明确 ACP detached task 的实际启动入口
2. 在 ACP 执行链路中拿到标准 terminal 结果
3. 将 terminal 结果传入 host detached task 的 `onTerminal` 语义
4. 保证 terminal 回调只触发一次

### 修改重点文件

- `src/acp/control-plane/manager.ts`
- `src/runtime/host/message-handler.ts`
- 视实际 wiring 结果，补入口层调用文件

### 完成标准

- ACP task 正常完成时，host 能收到一次 `completed`
- ACP task 出错时，host 能收到一次 `failed`
- ACP task 取消/超时时，host 能收到相应终态
- 不出现重复 terminal callback

---

## Phase 2：将 registry 提升为通用 detached task registry

### 目标

让 ACP terminal 结果进入持久化、去重、announce、reconcile 闭环。

### 必做事项

1. 扩展 `EnhancedSubAgentRegistry` record，加入 `kind`
2. 确保 ACP task 能 register / markStarted / setTerminal
3. 保持现有 subagent 行为不变
4. 不新增第二套 ACP registry

### 修改重点文件

- `src/runtime/host/sessions/subagent-registry.ts`
- 对应 integration test 文件

### 数据模型要求

现有 record 扩展为 detached task 通用 record，最少新增：

```ts
kind: "subagent" | "acp"
```

如确有必要，再增加 ACP 专属可选字段，但不得影响 subagent 现有测试契约。

### 完成标准

- ACP task 可进入与 subagent 相同的 register/start/terminal 流程
- terminal 状态会被持久化
- 已终态且已 announce 的记录具备相同 cleanup/reap 语义

---

## Phase 3：抽象 announce helper，区分 ACP 与 subagent 语义

### 目标

完成“复用实现、不混淆产品语义”的 announce 设计。

### 必做事项

1. 将 `announceSubagentResult(...)` 提升为通用 detached task announce helper，或在其上一层新增通用包装器
2. 为 ACP task 定义独立 `taskKind` / metadata 契约
3. 明确父会话看到的展示文本
4. 保证 subagent 旧行为兼容

### 修改重点文件

- `src/runtime/host/sessions/subagent-announce.ts`
- 可能新增一个通用 detached task announce 文件
- 相关测试文件

### 完成标准

- ACP completion notify 不再伪装为 subagent
- 父会话能区分完成的是 `subagent` 还是 `acp`
- 现有 subagent 通知行为不被破坏

---

## Phase 4：重启补偿与 orphan reconcile

### 目标

保证 ACP detached task 与 subagent 一样具备 restart-safe completion notify。

### 必做事项

1. 扩展现有 `reconcileOrphanedRuns()`，覆盖 `kind = "acp"` 的终态任务
2. 对 terminal-but-unannounced ACP 任务重试 announce
3. 对 accepted/started 等非终态 ACP 任务在 host 重启后标记失败并通知父会话
4. 保持去重语义

### 修改重点文件

- `src/runtime/host/sessions/subagent-registry.ts`
- host 启动 wiring 所在文件（以实际 wiring 为准）

### 完成标准

- ACP 已终态但未 announce 的任务，重启后会补发一次
- ACP 非终态 orphan 任务，重启后会转失败并通知父会话
- 不会重复通知已 announce 任务

---

## 六、文件级改动清单

## 必改

### 1. `src/acp/control-plane/manager.ts`

职责：

- 明确 ACP terminal 归一化输出
- 将 terminal 结果暴露给宿主 detached callback 侧消费

要求：

- 不写 channel 通知逻辑
- 不写父会话 announce 逻辑
- 只负责正确、稳定地产出 terminal 结果

### 2. `src/runtime/host/message-handler.ts`

职责：

- 让 ACP detached task 接入现有 detached run lifecycle
- 在 `onTerminal` 边界驱动持久化与 announce

要求：

- terminal callback 只触发一次
- host 侧负责生命周期闭环，不把产品通知责任下放

### 3. `src/runtime/host/sessions/subagent-registry.ts`

职责：

- 提升为 detached task 通用 registry
- 增加 `kind` 支持
- 统一 ACP/subagent 的 terminal 去重与 reconcile

要求：

- 不破坏现有 subagent 行为
- 不增加重复 registry

### 4. `src/runtime/host/sessions/subagent-announce.ts`

职责：

- 抽象出 detached task 通知能力
- 区分 subagent 与 ACP 的 metadata / 文案语义

要求：

- ACP 不直接写 subagent 专用 metadata
- 支持未来扩展更多 detached task kind

## 视情况修改

### 5. `src/agents/tools/sessions-acp.ts`

职责：

- 仅保留初始化职责
- 如有必要，只补最少的 task kind / wiring 信息

要求：

- 不把它升级成 completion 中心
- 不在这里发终态 announce

### 6. host 启动 wiring 文件

职责：

- 确保 registry reconcile 在 host 启动时执行

要求：

- 与现有 subagent reconcile 使用同一入口或兼容入口
- 不分裂启动补偿逻辑

---

## 七、明确不做的事

本次改造**明确不做**以下内容：

1. 不重写 ACP backend
2. 不让 ACP runtime adapter 直接发父会话通知
3. 不新增平行于 host detached lifecycle 的第二套 ACP lifecycle manager
4. 不先建 `AcpRunRegistry`，除非复用方案被证明不可行
5. 不把 ACP completion 在产品语义上伪装成 subagent completion

---

## 八、测试方案

## 8.1 单元测试

### ACP terminal 归一化测试

覆盖：

- `done → completed`
- `error → failed`
- cancel → `aborted`
- timeout → `timeout`
- terminal 只产出一次

### Detached callback 测试

覆盖：

- ACP detached task 完成时 `onTerminal` 被调用一次
- partial text / reason / errorCode 映射正确

## 8.2 Registry 集成测试

覆盖：

- ACP task register → start → terminal 正常持久化
- terminal announce 成功后 `announced = true`
- announce 失败时终态保留但不标记 announced
- host 重启后 `reconcileOrphanedRuns()` 能补发 ACP terminal notify

## 8.3 语义测试

覆盖：

- ACP notify payload 包含 `taskKind = "acp"`
- ACP 不写入 subagent 专用 metadata 字段
- subagent 旧 payload 兼容不回归

## 8.4 回归测试

覆盖：

- 现有 detached subagent 流程不受影响
- 现有 subagent restart reconcile 不回归
- ACP session 初始化与正常 turn 执行不回归

---

## 九、实施顺序

严格按以下顺序执行：

1. **先实现 terminal 归一化与 host callback 接通**
2. **再扩展 registry 成通用 detached task registry**
3. **再抽象 announce helper，修正 ACP 语义**
4. **最后补 restart reconcile 与 orphan 补偿**
5. **最后统一跑 check / test / review**

禁止跳步直接做 registry 拆分或 announce 改名，否则容易在没有统一 terminal 边界前提前扩散复杂度。

---

## 十、验收标准

以下条件全部满足，才算完成：

- [ ] ACP detached task 已接入统一 host terminal callback
- [ ] ACP terminal 结果会被可靠持久化
- [ ] ACP completion 会向父会话发送一次且仅一次通知
- [ ] ACP completion notify 在产品语义上可区分于 subagent
- [ ] host 重启后能补偿 ACP 已终态未通知任务
- [ ] host 重启后能清理并失败化 ACP orphan 非终态任务
- [ ] 未新增重复的 ACP 专用 lifecycle/registry，除非实现中已给出充分理由
- [ ] 现有 subagent detached runtime 行为无回归
- [ ] `pnpm run check` 通过
- [ ] `pnpm run test` 通过

---

## 十一、最终结论

ACP session 的正确升级方向不是“再造一套 ACP detached task 系统”，而是：

**把 ACP 正确接入现有 host detached lifecycle、通用 detached task registry，以及可靠 announce / reconcile 闭环。**

本方案的核心价值在于：

- 保持宿主语义单一
- 控制架构复杂度
- 最大化复用现有稳定能力
- 让 ACP 与 subagent 在同一 detached task 体系内演进，但保持产品语义清晰分离

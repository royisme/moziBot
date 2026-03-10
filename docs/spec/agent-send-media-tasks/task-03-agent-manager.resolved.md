# Task 03: AgentManager Session Context + execution-flow Registration

## 依赖
- task-01：需要 `ChannelDispatcherBridge` 类型（来自 `contract.ts`，task-01 无修改，但 task-03 需要该类型已存在）

## 目标
在 `AgentManager` 新增 session context 存储机制，并在 `execution-flow.ts` 的 turn 开始处调用注册，使 `send_media` 工具在执行时能懒获取当前 channel/peerId。

## 涉及文件
- `src/runtime/agent-manager.ts` — 修改：新增字段 + 两个公开方法 + cleanup
- `src/runtime/host/message-handler/contract.ts` — 修改：`OrchestratorDeps` 新增可选方法
- `src/runtime/host/message-handler/flow/execution-flow.ts` — 修改：turn 开始处注册 context
- `src/runtime/host/message-handler/services/orchestrator-deps-builder.ts` — 修改：实现新方法

## 实现要点

### 1. `agent-manager.ts`

**新增 import**（顶部）：
```ts
import type { ChannelDispatcherBridge } from "./host/message-handler/contract";
```

**新增私有字段**（在 `private tapeServices` 之后）：
```ts
private sessionContexts = new Map<string, { channel: ChannelDispatcherBridge; peerId: string }>();
```

**新增公开方法**（在 `disposeRuntimeSession` 附近）：
```ts
registerSessionContext(
  sessionKey: string,
  ctx: { channel: ChannelDispatcherBridge; peerId: string },
): void {
  this.sessionContexts.set(sessionKey, ctx);
}

getSessionContext(
  sessionKey: string,
): { channel: ChannelDispatcherBridge; peerId: string } | undefined {
  return this.sessionContexts.get(sessionKey);
}
```

**修改 `disposeRuntimeSession`**（在现有 delete 调用之后添加）：
```ts
this.sessionContexts.delete(sessionKey);
```

### 2. `contract.ts` — `OrchestratorDeps`

在现有方法列表末尾（Error Helpers 区域之前或之后）新增可选方法：

```ts
registerSessionContext?(
  sessionKey: string,
  ctx: { channel: ChannelDispatcherBridge; peerId: string },
): void;
```

### 3. `execution-flow.ts`

在 `const channel = getChannel(payload)` 之后（约 line 162），插入：

```ts
// Register channel/peerId for send_media lazy lookup
deps.registerSessionContext?.(sessionKey, { channel, peerId });
```

使用可选链调用（`?.`）保证向后兼容——未实现该方法的 orchestrator 不受影响。

### 4. `orchestrator-deps-builder.ts`

找到构建 `OrchestratorDeps` 对象的地方，新增：

```ts
registerSessionContext: (sessionKey, ctx) => agentManager.registerSessionContext(sessionKey, ctx),
```

其中 `agentManager` 是该 builder 已有的引用（grep `agentManager` 确认变量名）。

## 验收标准
- [ ] `pnpm run check` 通过
- [ ] 新增单元测试验证 session context 生命周期：
  - `registerSessionContext("k", ctx)` → `getSessionContext("k")` 返回 ctx
  - `disposeRuntimeSession("k")` 之后 `getSessionContext("k")` 返回 `undefined`
- [ ] `execution-flow.test.ts` 现有测试不回归
- [ ] `contract.ts` 中 `registerSessionContext?` 为可选（不破坏已有 mock/stub）

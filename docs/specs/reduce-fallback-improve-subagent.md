# Spec: 减少不必要的模型 Fallback & 改善 Subagent 使用

## 背景

moziBot 在执行任务时频繁出现 "Primary model failed this turn; using fallback model qwen35" 的问题。
根因是错误分类过粗 + subagent 未被主动使用，导致主模型直接承担所有工作，遇错即 fallback。

对比 OpenClaw，其错误分类有 8 种 reason，且 subagent 默认可用、支持嵌套 spawn。

---

## 变更 1: 细化错误分类，减少误 fallback

### 文件: `src/runtime/core/error-policy.ts`

**现状：** 只有 `isTransientError` 和 `isCapabilityError` 两个分类函数。任何不匹配的错误都被视为 terminal，触发 fallback。

**改动：** 新增两个分类函数：

```typescript
/** 模型输出格式错误（JSON parse 失败、tool call schema 不匹配等）—— 应重试同模型 */
export function isFormatError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("invalid json") ||
    lower.includes("json parse") ||
    lower.includes("unexpected token") ||
    lower.includes("tool_use") && lower.includes("schema") ||
    lower.includes("malformed") ||
    lower.includes("invalid tool") ||
    lower.includes("parse error")
  );
}

/** 认证/计费类错误 —— 应 fallback 到其他模型 */
export function isAuthOrBillingError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("401") ||
    lower.includes("402") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("billing") ||
    lower.includes("quota exceeded") ||
    lower.includes("insufficient")
  );
}
```

**修改 `DefaultRuntimeErrorPolicy.decide()`：**

```typescript
decide(error: Error, attempt: number): RuntimeErrorDecision {
  if (isCapabilityError(error.message)) {
    return { retry: false, delayMs: 0, reason: "capability_error" };
  }
  // 新增: 格式错误 → 同模型重试（最多 2 次）
  if (isFormatError(error.message) && attempt < 2) {
    return { retry: true, delayMs: 500, reason: "format_error" };
  }
  // 新增: 认证/计费错误 → 不重试，直接 fallback
  if (isAuthOrBillingError(error.message)) {
    return { retry: false, delayMs: 0, reason: "auth_billing_error" };
  }
  if (isTransientError(error.message) && attempt < this.maxRetries) {
    return { retry: true, delayMs: this.baseDelayMs * 2 ** attempt, reason: "transient_error" };
  }
  return { retry: false, delayMs: 0, reason: "terminal_error" };
}
```

### 文件: `src/runtime/host/message-handler/services/prompt-runner.ts`

**现状（L425-445 的 catch 块）：** transient error 重试 2 次后，任何其他错误一律 fallback。

**改动：** 在 transient retry 逻辑之后、fallback 逻辑之前，增加 format error 重试：

```typescript
// 在 transient retry 代码块之后新增:
if (isFormatError(error.message)) {
  const formatAttempts = formatRetryCounts.get(modelRef) ?? 0;
  if (formatAttempts < 2) {
    formatRetryCounts.set(modelRef, formatAttempts + 1);
    deps.logger.warn(
      { traceId, sessionKey, agentId, modelRef, attempt, formatAttempts: formatAttempts + 1 },
      "Format error, retrying same model",
    );
    await new Promise((r) => setTimeout(r, 500));
    continue;
  }
}
```

在函数开头声明 `const formatRetryCounts = new Map<string, number>();`（与现有 `transientRetryCounts` 并列）。

需要在文件顶部 import `isFormatError` from `../../core/error-policy`。

---

## 变更 2: 扩展 isTransientError 覆盖范围

### 文件: `src/runtime/core/error-policy.ts`

**现状：** `isTransientError` 匹配有限，很多实际可恢复的错误未被覆盖。

**改动：** 在现有匹配项之后追加：

```typescript
lower.includes("econnreset") ||
lower.includes("econnrefused") ||
lower.includes("etimedout") ||
lower.includes("socket hang up") ||
lower.includes("500") ||
lower.includes("502") ||
lower.includes("504") ||
lower.includes("service unavailable") ||
lower.includes("bad gateway")
```

---

## 变更 3: 放开 Subagent 嵌套限制

### 文件: `src/runtime/subagent-registry.ts`

**现状（L64-73）：** `ensureAllowed` 中硬编码禁止主 agent 被调用为 subagent，且嵌套 spawn 无法实现（subagent 没有 subagent 工具）。

**改动 a：** 增加 `maxSpawnDepth` 支持（默认 2 层）。

在 `SubagentRegistry` 类中新增：

```typescript
private readonly maxSpawnDepth: number = 2;

/** 获取当前 spawn 深度 */
private getSpawnDepth(sessionKey: string): number {
  // 从 sessionKey 中解析 depth，或维护一个 depth map
  return this.depthMap.get(sessionKey) ?? 0;
}
```

在 `run()` 方法中，创建子 agent session 时：
- 记录 depth = parentDepth + 1
- 当 depth < maxSpawnDepth 时，子 agent 也获得 `subagent_run` 工具

**改动 b：** `ensureAllowed` 放宽为 depth 检查：

```typescript
private ensureAllowed(params: { parentAgentId: string; targetAgentId: string; sessionKey: string }) {
  if (params.targetAgentId === "mozi") {
    throw new Error("Primary agent cannot be called as a subagent");
  }
  const depth = this.getSpawnDepth(params.sessionKey);
  if (depth >= this.maxSpawnDepth) {
    throw new Error(`Max subagent spawn depth (${this.maxSpawnDepth}) reached`);
  }
  const parentEntry = this.agentManager.getAgentEntry(params.parentAgentId);
  const allow = parentEntry?.subagents?.allow ?? [];
  if (!allow.includes(params.targetAgentId)) {
    throw new Error(`Subagent not allowlisted: ${params.targetAgentId}`);
  }
}
```

### 文件: `src/config/schema/agents.ts`

**改动：** `SubagentPolicySchema` 增加 `maxDepth` 字段：

```typescript
SubagentPolicySchema = z.object({
  allow: z.array(z.string()).optional(),
  promptMode: SubagentPromptModeSchema.optional(),
  maxDepth: z.number().int().min(0).max(5).optional().default(2),
}).strict()
```

---

## 变更 4: 默认 agent 配置启用 subagent 工具

### 文件: `src/runtime/agent-manager/tool-builder.ts`

**现状（L180）：** 只有 `allowSet.has("subagent_run")` 时才注册 subagent 工具。这依赖 agent 配置里显式列出 `subagent_run`。

**改动：** 当 `deps.subagents` 存在时，默认注册 subagent 工具，除非 agent 配置显式排除：

```typescript
// 原: if (deps.subagents && allowSet.has("subagent_run")) {
// 改:
const denySet = new Set(params.agentEntry?.tools?.deny ?? []);
if (deps.subagents && !denySet.has("subagent_run")) {
```

这样所有 agent 默认可用 subagent，除非在 `tools.deny` 中显式禁用。

---

## 测试计划

1. **error-policy.test.ts**: 新增 `isFormatError` 和 `isAuthOrBillingError` 的单元测试
2. **prompt-runner.test.ts**: 验证 format error 触发同模型重试而非 fallback
3. **prompt-runner.test.ts**: 验证扩展后的 transient error 匹配（econnreset 等）
4. **subagent-registry.test.ts**: 验证 depth 限制生效、depth 超限抛错
5. **tool-builder.test.ts**: 验证 subagent 工具默认注册、deny 列表可排除

## 影响范围

- `src/runtime/core/error-policy.ts` — 错误分类
- `src/runtime/host/message-handler/services/prompt-runner.ts` — fallback 循环
- `src/runtime/subagent-registry.ts` — 嵌套 depth 控制
- `src/config/schema/agents.ts` — schema 扩展
- `src/runtime/agent-manager/tool-builder.ts` — 默认启用 subagent

## 不改动

- Fallback 消息格式（`execution-flow.ts`）保持不变
- `MAX_CONCURRENT_SUBAGENTS = 2` 并发限制保持不变
- 现有 agent 配置文件无需修改即可生效（向后兼容）

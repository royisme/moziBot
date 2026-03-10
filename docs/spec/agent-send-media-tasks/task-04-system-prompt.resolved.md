# Task 04: System Prompt — `buildChannelContext` send_media 过滤

## 依赖
无依赖（可与 task-01、task-02 并行执行）

## 目标
修改 `buildChannelContext()` 使其接受 `registeredTools?` 参数，当 `send_media` 未注册为实际工具时从 `allowedActions` 中过滤掉，并在已注册时追加使用说明。

## 涉及文件
- `src/runtime/agent-manager/prompt-builder.ts` — 修改：`buildChannelContext` 签名 + 内部逻辑
- `src/runtime/agent-manager.ts` — 修改：`ensureChannelContext` 中的调用点传入 `registeredTools`

## 实现要点

### 1. `prompt-builder.ts` — 函数签名

```ts
export function buildChannelContext(
  message: InboundMessage,
  currentChannel?: CurrentChannelContext,
  registeredTools?: string[],   // 新增第三参数
): string {
```

### 2. `allowedActions` 过滤逻辑

将现有的 `allowedActions` 输出行替换为：

```ts
if (currentChannel) {
  // ... 其他字段保持不变 ...

  const effectiveActions = currentChannel.allowedActions.filter((action) => {
    if (action === "send_media") {
      return registeredTools?.includes("send_media") ?? false;
    }
    return true;
  });
  lines.push(
    `allowedActions: ${effectiveActions.map((a) => sanitizePromptLiteral(a)).join(", ")}`,
  );
  if (effectiveActions.includes("send_media")) {
    lines.push(
      "When send_media is listed, use the send_media tool with a local filePath — do not search for tokens or scripts.",
    );
  }

  // ... 其余字段（supportsMedia 等）保持不变 ...
}
```

**注意**：只过滤 `send_media`，其他 `allowedActions` 条目不受影响。

### 3. `agent-manager.ts` — `ensureChannelContext` 调用点

在 `ensureChannelContext()` 方法内（约 line 597），修改 `buildChannelContext` 调用：

```ts
// 现有：
const channelContext = buildChannelContext(message, currentChannel);

// 改为：
const registeredTools = this.promptToolsBySession.get(sessionKey);
const channelContext = buildChannelContext(message, currentChannel, registeredTools);
```

`promptToolsBySession` 在 `getAgent` 的 `onToolsResolved` 回调中被填充，时序上早于 `ensureChannelContext` 的调用（每次 turn 都会先经过 `getAgent`），因此该 Map 在此处已有值。

## 验收标准
- [ ] `pnpm run check` 通过
- [ ] 新增/更新 `prompt-builder.ts` 对应的测试：
  - 当 `registeredTools` 不含 `"send_media"` 时，`allowedActions` 输出中不包含 `send_media`
  - 当 `registeredTools` 含 `"send_media"` 时，`allowedActions` 输出中包含 `send_media` 且追加使用说明行
  - 不传 `registeredTools`（`undefined`）时，`send_media` 被过滤（默认安全）
- [ ] 现有 `prompt-builder` 测试不回归（注意：如有测试断言 `allowedActions` 包含 `send_media`，需相应更新）

# Task 02: Tool Builder Integration

## 依赖
- task-01：需要 `createSendMediaTool` 的类型签名（`AgentTool` 返回值）

## 目标
修改 `tool-builder.ts`，在 `BuildToolsDeps` 中增加 `createSendMediaTool?` 可选工厂字段，并在 `buildTools()` 中接入。

## 涉及文件
- `src/runtime/agent-manager/tool-builder.ts` — 修改

## 实现要点

**`BuildToolsDeps` 新增字段**（在 `toolProvider?` 字段之后插入）：

```ts
/**
 * Factory for the send_media tool. When provided and "send_media" is in the
 * allowList, the tool is included in the session's tool set.
 * The factory receives workspaceDir/homeDir; channel/peerId are resolved lazily at call time.
 */
createSendMediaTool?: (params: { workspaceDir: string; homeDir: string }) => AgentTool;
```

**`buildTools()` 中插入位置**：在 `if (deps.toolProvider)` 块之前（约 line 277）：

```ts
if (deps.createSendMediaTool && allowSet.has("send_media")) {
  tools.push(
    deps.createSendMediaTool({ workspaceDir: params.workspaceDir, homeDir: params.homeDir }),
  );
}
```

该工具随其他工具一起经过 `wrapToolWithRuntimeHooks` 包装，无需特殊处理。

**注意**：`BuildToolsDeps` 中的 `createSendMediaTool` 工厂只接收静态参数（workspaceDir/homeDir），不接收 channel/peerId。channel/peerId 由工具内部的 `deps.getChannel()` / `deps.getPeerId()` 闭包在执行时获取（由 task-03 提供的 session context 机制支撑）。

## 验收标准
- [ ] `pnpm run check` 通过
- [ ] `pnpm run test` — tool-builder 相关现有测试不回归
- [ ] `send_media` 不在 allowList 时，`createSendMediaTool` 即使有值也不被调用（由 `allowSet.has("send_media")` 保证）

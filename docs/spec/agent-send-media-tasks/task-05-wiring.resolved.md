# Task 05: Wiring — 注入工厂 + Agent Config

## 依赖
- task-02：`BuildToolsDeps.createSendMediaTool?` 字段已存在
- task-03：`agentManager.getSessionContext()` 方法已存在
- task-04：`buildChannelContext` 签名已更新（可选，但建议 task-04 先完成以避免 TS 错误）

## 目标
在 `message-handler.ts` 的 `setToolProvider` 调用处注入 `createSendMediaTool` 工厂，并为需要该功能的 agent 在 YAML config 的 `tools` 字段中添加 `"send_media"`。

## 涉及文件
- `src/runtime/host/message-handler.ts` — 修改：`setToolProvider` 回调注入工厂
- agent config YAML（如 `config/mozi.yaml` 或等价配置文件）— 修改：目标 agent 的 `tools` 数组

## 实现要点

### 1. `message-handler.ts` — 重构 `setToolProvider`

当前代码（约 line 243-255）只在 `deps?.sessionManager && deps?.detachedRunRegistry` 存在时才调用 `setToolProvider`。`send_media` 应无条件注入。

**修改方案**：将 `setToolProvider` 调用移到条件判断外，内部按条件组装工具列表：

```ts
import { createSendMediaTool } from "../tools/send-media";

// 在 constructor 或 init 方法中，替换原有的 if (deps?.sessionManager...) 块：
this.agentManager.setToolProvider((params) => {
  const tools: import("@mariozechner/pi-agent-core").AgentTool[] = [];

  if (deps?.sessionManager && deps?.detachedRunRegistry) {
    tools.push(
      ...createSessionTools({
        sessionManager: deps.sessionManager!,
        detachedRunRegistry: deps.detachedRunRegistry!,
        currentSessionKey: params.sessionKey,
        config: this.config,
      }),
      ...createBrowserTools({
        getConfig: () => this.config,
      }),
    );
  }

  tools.push(
    createSendMediaTool({
      workspaceDir: params.workspaceDir,
      getChannel: () => this.agentManager.getSessionContext(params.sessionKey)?.channel,
      getPeerId: () => this.agentManager.getSessionContext(params.sessionKey)?.peerId,
    }),
  );

  return tools;
});
```

**注意**：`createSendMediaTool` 返回的工具名是 `"send_media"`。`buildTools()` 中的 `filterTools(provided, allowList)` 会在 `toolProvider` 返回的列表上再做过滤，因此只有 agent config 中 `tools` 包含 `"send_media"` 的 agent 才会实际注册该工具。不需要在这里做额外的 allowList 检查。

### 2. Agent Config — 添加到 allowlist

在需要发送媒体的 agent 配置中添加（YAML 路径视项目实际配置文件而定，通常是 `config/mozi.yaml` 或 `mozi.yaml`）：

```yaml
agents:
  mozi:       # 替换为实际需要 send_media 的 agent ID
    tools:
      - send_media
      # 其他已有工具保持不变
```

### 3. local-desktop channel 验证

阅读 `src/runtime/adapters/channels/local-desktop/plugin.ts`，确认 `getCapabilities()` 返回的 `media` 字段值：
- 若 `media: false`，工具会在执行时返回 `channel_no_media_support` 错误（符合预期，无需修改）
- 若需要 local-desktop 也支持，需在该 plugin 的 `send()` 中补充 `media[0].buffer` 处理路径

Telegram 和 Discord 已确认支持（spec Section 7），无需改动。

## 验收标准
- [ ] `pnpm run check` 通过
- [ ] agent 未在 config tools 中列出 `send_media` 时，工具不出现在 session 的 tool 列表中
- [ ] agent 列出 `send_media` 后，`agent.state.tools` 中包含名为 `send_media` 的工具（参考 `agent-manager.tools.integration.test.ts` 的测试模式）
- [ ] 端到端验证（可手动）：触发 agent 调用 `send_media` 工具，Telegram/Discord 频道收到图片附件
- [ ] `setToolProvider` 重构后，原有 session tools / browser tools 功能不回归

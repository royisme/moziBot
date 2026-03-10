# Spec: Agent Send Media Tool (`send_media`)

## 1. 背景与问题陈述

Telegram agent 的 system prompt 中 `allowedActions` 已包含 `send_media`，但 `buildTools()` 从未注册对应的 `AgentTool`，导致 LLM 在需要发送本地文件时没有工具可调用。

底层发送路径已经完整：`telegram/send.ts` 的 `sendMessage()` 在 `message.media[0].path` 有值时会读取本地文件并调用 `bot.api.sendPhoto / sendDocument` 等。缺失的只是"LLM → `dispatchReply({ media })` "这一段工具调用桥接。

---

## 2. 功能范围

### 支持

| 维度 | 范围 |
|------|------|
| 媒体类型 | `photo`（jpg/png/gif/webp）、`video`（mp4）、`audio`（mp3/ogg/wav）、`document`（其余所有） |
| 推断方式 | 优先以 LLM 传入的 `mediaType` 参数为准；缺省时按扩展名推断 |
| Channel | telegram、discord、local-desktop（三者均通过现有 `channel.send()` 发送，无需特判） |
| 路径来源 | 本地绝对路径（`filePath`）；不支持 URL（URL 走现有 agent reply 文本链接） |

### 不支持（本次）

- 批量发送多个文件（单次调用只发一个附件）
- 远程 URL 下载再发送
- Discord 的 embed 富格式
- 文件大小超过 Telegram 50MB 上限时自动拆分

---

## 3. Tool Schema 设计

### Tool Name：保持 `send_media`

理由：moziBot 已在 `ChannelActionName`、system prompt 的 `allowedActions`、以及 `ChannelCapabilities.supportedActions` 中使用 `send_media` 这一名称。沿用此名可以保持"system prompt 中声明什么 → agent 调用什么"的一致性，无需同步修改多处。OpenClaw 用 `message` 是因为它把文字回复和媒体合并成了一个工具，而 moziBot 的文字回复走 agent 直接 reply，两者模型不同。

### Input Schema（JSON Schema）

```ts
// 注册时使用的 JSON Schema 对象
const sendMediaInputSchema = {
  type: "object",
  properties: {
    filePath: {
      type: "string",
      description:
        "Absolute path to the local file to send. Must be within an allowed root directory.",
    },
    caption: {
      type: "string",
      description: "Optional caption text to attach to the media (max 1024 chars for Telegram).",
    },
    mediaType: {
      type: "string",
      enum: ["photo", "video", "audio", "document"],
      description:
        "Optional hint for media type. If omitted, the runtime infers from the file extension.",
    },
  },
  required: ["filePath"],
  additionalProperties: false,
} as const;
```

### 安全约束：localRoots 白名单

工具在执行时验证 `filePath` 满足：

1. 是绝对路径（`path.isAbsolute(filePath) === true`）
2. 经 `path.resolve()` 标准化后，以某个 `localRoot` 开头（`resolvedPath.startsWith(root + "/")` 或等于 `root`）
3. 不包含 `..` 穿越（`path.resolve` 已消除，只需验证前缀即可）

默认 `localRoots`（可通过 agent 配置覆盖）：

```ts
const DEFAULT_LOCAL_ROOTS = [
  resolveWorkspaceDir(config, agentId, entry),  // agent workspace
  path.join(os.homedir(), "Downloads"),
  path.join(os.homedir(), "Desktop"),
  path.join(os.homedir(), "Pictures"),
  path.join(os.homedir(), "Movies"),
  path.join(os.homedir(), "Music"),
];
```

路径验证失败时返回工具错误结果，不抛出异常（LLM 能收到错误描述并重试）。

---

## 4. 注册位置

### 决策：在 `tool-builder.ts` 的 `buildTools()` 中注册，受 allowList 控制

理由：

- `buildTools()` 是所有工具的单一汇集点，包括 `exec`、`memory_search`、`skills_note` 等，所有工具都经过 `allowSet.has(toolName)` 过滤和 `wrapToolWithRuntimeHooks()` 包装。
- `send_media` 需要访问 `workspaceDir`（用于 localRoots 计算），这些参数在 `BuildToolsParams` 中已有。
- `send_media` 需要 `dispatchReply` 的能力，但 tool-builder 层面没有 `dispatchReply`——这是关键问题，见下一节的解决方案。

### 解决 `dispatchReply` 访问问题

`dispatchReply` 存在于 `OrchestratorDeps` 中，在 `execution-flow.ts` 的作用域内，而 `buildTools()` 在 session 初始化时就被调用，彼时没有 delivery context。

**解决方案：使用闭包延迟绑定（lazy delivery context）**

`setToolProvider` 回调仅接收 `{ sessionKey, agentId, workspaceDir, homeDir, sandboxConfig }`，不直接提供 channel 或 peerId。channel 和 peerId 是 execution-flow 内的局部变量（`const channel = getChannel(payload)` 和 `const peerId = state.peerId`），需要通过闭包捕获。

**推荐实现路径**：

1. 在 `setToolProvider` 回调中，传入一个 `getChannelAndPeerId` 函数，该函数内部捕获 execution-flow 状态：

```ts
agentManager.setToolProvider(async ({ sessionKey, agentId, workspaceDir, homeDir }) => {
  // 使用闭包捕获当前的 channel 和 peerId（从 orchestrator 状态或 flow 局部变量获取）
  const getChannel = () => {
    // 从 orchestrator 或 turn-runtime 的状态中获取
    return agentManager.getChannelForSession(sessionKey);
  };
  const getPeerId = () => agentManager.getPeerIdForSession(sessionKey);

  return [
    createSendMediaTool({
      workspaceDir,
      getChannel,
      getPeerId,
    }),
  ];
});
```

2. 由于 `AgentManager` 没有直接暴露 channel/peerId 的 getters，需要通过 `orchestrator` 或在 flow 执行时注册。具体做法：
   - 在 `execution-flow.ts` 开始执行 turn 时，通过 `agentManager.registerSessionContext(sessionKey, { channel, peerId })` 注册上下文
   - tool 执行时通过 `agentManager.getSessionContext(sessionKey)` 获取

3. 新建 `src/runtime/tools/send-media.ts` 导出 `createSendMediaTool(deps)`，deps 包含：
   - `getChannel: () => ChannelDispatcherBridge` — 懒获取当前 session 的 channel bridge
   - `getPeerId: () => string` — 获取当前 session 的 peerId
   - `workspaceDir: string`
   - `extraLocalRoots?: string[]`

**注意**：`orchestrator.getActiveChannel(sessionKey)` 方法不存在，实际需要通过 `state.peerId` 和 `deps.getChannel(payload)` 在 flow 执行时获取，或新增 session-context 注册机制。

---

## 5. Tool Handler 实现

### 新文件：`src/runtime/tools/send-media.ts`

```ts
import path from "node:path";
import os from "node:os";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MediaAttachment } from "../adapters/channels/types";
import type { ChannelDispatcherBridge } from "../host/message-handler/contract";
import { logger } from "../../logger";

export interface SendMediaToolDeps {
  /** Returns the channel bridge for the current session turn. */
  getChannel: () => ChannelDispatcherBridge | undefined;
  /** Returns the current peerId. */
  getPeerId: () => string | undefined;
  /** Agent workspace directory, always included in allowed roots. */
  workspaceDir: string;
  /** Additional allowed roots beyond the defaults. */
  extraLocalRoots?: string[];
}

const DEFAULT_LOCAL_ROOT_SUFFIXES = ["Downloads", "Desktop", "Pictures", "Movies", "Music"];

function resolveLocalRoots(workspaceDir: string, extra?: string[]): string[] {
  const home = os.homedir();
  return [
    workspaceDir,
    ...DEFAULT_LOCAL_ROOT_SUFFIXES.map((s) => path.join(home, s)),
    ...(extra ?? []),
  ].map((r) => path.resolve(r));
}

function isPathAllowed(filePath: string, localRoots: string[]): boolean {
  if (!path.isAbsolute(filePath)) return false;
  const resolved = path.resolve(filePath);
  return localRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
}

function inferMediaType(
  filePath: string,
  hint?: string,
): MediaAttachment["type"] {
  if (hint === "photo" || hint === "video" || hint === "audio" || hint === "document") {
    return hint;
  }
  const ext = path.extname(filePath).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return "photo";
  if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) return "video";
  if ([".mp3", ".ogg", ".wav", ".m4a", ".flac"].includes(ext)) return "audio";
  return "document";
}

export function createSendMediaTool(deps: SendMediaToolDeps): AgentTool {
  const localRoots = resolveLocalRoots(deps.workspaceDir, deps.extraLocalRoots);

  return {
    name: "send_media",
    description:
      "Send a local media file (photo, video, audio, or document) to the current channel conversation. " +
      "filePath must be an absolute path within the agent workspace or standard user media directories.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the local file to send.",
        },
        caption: {
          type: "string",
          description: "Optional caption text (max 1024 chars on Telegram).",
        },
        mediaType: {
          type: "string",
          enum: ["photo", "video", "audio", "document"],
          description: "Optional media type hint; inferred from extension if omitted.",
        },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, rawArgs: unknown) => {
      const args = rawArgs as { filePath?: string; caption?: string; mediaType?: string };
      const filePath = args.filePath ?? "";
      const caption = args.caption;
      const mediaTypeHint = args.mediaType;

      // Security: path validation
      if (!isPathAllowed(filePath, localRoots)) {
        return {
          content: [
            {
              type: "text",
              text: `Access denied: "${filePath}" is outside the allowed directories. Allowed roots: ${localRoots.join(", ")}`,
            },
          ],
          details: { error: "path_not_allowed", filePath },
        };
      }

      // Check file exists via Bun.file
      const bunFile = Bun.file(filePath);
      const exists = await bunFile.exists();
      if (!exists) {
        return {
          content: [{ type: "text", text: `File not found: "${filePath}"` }],
          details: { error: "file_not_found", filePath },
        };
      }

      const channel = deps.getChannel();
      const peerId = deps.getPeerId();

      if (!channel || !peerId) {
        return {
          content: [{ type: "text", text: "No active channel context available." }],
          details: { error: "no_channel_context" },
        };
      }

      // Check channel capability
      const caps = channel.getCapabilities();
      if (!caps.media) {
        return {
          content: [{ type: "text", text: "The current channel does not support media attachments." }],
          details: { error: "channel_no_media_support" },
        };
      }

      const mediaType = inferMediaType(filePath, mediaTypeHint);
      const filename = path.basename(filePath);

      // Read file into buffer via Bun
      let buffer: Buffer;
      try {
        const ab = await bunFile.arrayBuffer();
        buffer = Buffer.from(ab);
      } catch (err) {
        logger.warn({ err, filePath }, "send_media: failed to read file");
        return {
          content: [{ type: "text", text: `Failed to read file: ${String(err)}` }],
          details: { error: "file_read_error", filePath },
        };
      }

      const media: import("../adapters/channels/types").MediaAttachment[] = [
        {
          type: mediaType,
          buffer,
          filename,
          caption,
        },
      ];

      try {
        const messageId = await channel.send(peerId, { media });
        return {
          content: [
            {
              type: "text",
              text: `Media sent successfully (messageId: ${messageId}, type: ${mediaType}, file: ${filename}).`,
            },
          ],
          details: { messageId, mediaType, filename, filePath },
        };
      } catch (err) {
        logger.error({ err, filePath, peerId }, "send_media: channel.send failed");
        return {
          content: [{ type: "text", text: `Failed to send media: ${String(err)}` }],
          details: { error: "send_failed", filePath },
        };
      }
    },
  };
}
```

---

## 6. Tool 注册连接点

### 在 `tool-builder.ts` 的 `BuildToolsDeps` 中增加可选字段

```ts
export interface BuildToolsDeps {
  // ... 现有字段 ...

  /**
   * Factory for the send_media tool. When provided and "send_media" is in the
   * allowList, the tool is included in the session's tool set.
   * The factory receives workspaceDir and must lazily resolve channel/peerId at call time.
   */
  createSendMediaTool?: (params: { workspaceDir: string; homeDir: string }) => AgentTool;
}
```

在 `buildTools()` 中添加：

```ts
if (deps.createSendMediaTool && allowSet.has("send_media")) {
  tools.push(
    deps.createSendMediaTool({
      workspaceDir: params.workspaceDir,
      homeDir: params.homeDir,
    }),
  );
}
```

### MessageHandler 组装层（`message-handler/index.ts` 或其 orchestrator 初始化）

在调用 `agentManager.setToolProvider()` 的地方（目前在 kernel 的 host 初始化层），注入 `createSendMediaTool`：

```ts
agentManager.setToolProvider(async ({ sessionKey, agentId, workspaceDir, homeDir }) => {
  return [
    createSendMediaTool({
      workspaceDir,
      getChannel: () => agentManager.getSessionChannel(sessionKey),  // 新增方法
      getPeerId: () => agentManager.getSessionPeerId(sessionKey),      // 新增方法
    }),
  ];
});
```

**关键**：需要在 `AgentManager` 新增 session-context 注册机制：

1. 新增方法 `registerSessionContext(sessionKey, { channel, peerId })` — 在 execution-flow 开始时调用
2. 新增方法 `getSessionChannel(sessionKey)` / `getSessionPeerId(sessionKey)` — 供 tool 使用

execution-flow 中已有 `channel`（来自 `getChannel(payload)`）和 `peerId`（来自 `state.peerId`），只需在 flow 开始处注册到 AgentManager。

**注意**：`send_media` 工具对 `allow_list` 的默认行为应当"只有在 config 中显式列出时才启用"，以防误开放给不需要的 agent。

---

## 7. 多 Channel 处理差异

**确认结论**：所有三个 Channel 已完整支持 `media[0].buffer` 路径，无需额外改动。

| Channel | buffer 支持情况 | 代码位置 |
|---------|---------------|----------|
| Telegram | 完整支持：`sendPhoto`/`sendVideo`/`sendAudio`/`sendDocument` 全部通过 `new InputFile(media.buffer, media.filename)` 发送 | `telegram/send.ts:100` |
| Discord | 完整支持：`resolveOutboundFiles()` 检查 `item.buffer && item.buffer.byteLength > 0`，转为 `MessagePayloadFile` 发送 | `discord/plugin.ts:1299-1304` |
| local-desktop | 需确认（通常直接渲染文件路径） | 待验证 |

工具层无需分支，只负责：
1. 读文件 → `buffer: Buffer`
2. 构造 `MediaAttachment`（包含 `type`, `buffer`, `filename`, `caption`）
3. 调用 `channel.send(peerId, { media })`

---

## 8. System Prompt 更新（`buildChannelContext`）

**当前问题**：`allowedActions` 中包含 `send_media` 但实际没有工具，LLM 被误导。

**确认结论**：`promptToolsBySession` 是私有 Map（无公开 getter），`buildChannelContext(message, currentChannel?)` 目前不接受 registeredTools 参数。

**修复方案**：给 `buildChannelContext` 增加可选的 `registeredTools?: string[]` 参数，由调用方传入。

1. 修改 `prompt-builder.ts`：
```ts
export function buildChannelContext(
  message: InboundMessage,
  currentChannel?: CurrentChannelContext,
  registeredTools?: string[],  // 新增
): string {
  // ...
  const effectiveAllowedActions = currentChannel?.allowedActions.filter((action) => {
    if (action === "send_media") {
      return registeredTools?.includes("send_media") ?? false;
    }
    return true;
  }) ?? currentChannel?.allowedActions ?? [];
  lines.push(`allowedActions: ${effectiveAllowedActions.join(", ")}`);
}
```

2. 在 `agent-manager.ts` 的 `ensureChannelContext()` 调用处传入：
```ts
const registeredTools = this.promptToolsBySession.get(sessionKey);
const channelContext = buildChannelContext(message, currentChannel, registeredTools);
```

另外，在 `allowedActions` 后添加使用说明：
```
When send_media is listed, use the send_media tool with a local filePath — do not search for tokens or scripts.
```

---

## 9. 测试策略

### 单元测试（`src/runtime/tools/send-media.test.ts`）

使用 `bun test`（vitest 兼容）：

```ts
// 测试点：
// 1. 路径白名单验证
//    - 工作区内路径 → 允许
//    - /etc/passwd → 拒绝
//    - ../../escape → 拒绝
//    - 相对路径 → 拒绝

// 2. 文件不存在 → 返回 file_not_found 错误内容

// 3. channel.getCapabilities().media === false → 返回 channel_no_media_support

// 4. 正常发送
//    - mock channel.send → 验证调用参数：media[0].buffer 非空, media[0].type 正确
//    - 验证 inferMediaType: .jpg → photo, .mp4 → video, .txt → document

// 5. mediaType hint 优先级高于扩展名推断

// 6. channel.send 抛出异常 → 返回 send_failed 错误内容，不向上抛
```

运行命令：
```sh
pnpm run test src/runtime/tools/send-media.test.ts
```

### 集成测试要点

- Telegram E2E：在 sandbox 中创建临时文件，触发 send_media 工具调用，验证 Telegram bot 收到 `sendDocument` 请求（可通过 grammy mock 或录制）
- 验证 `send_media` 不出现在未配置该工具的 agent 的 allowedActions 中

---

## 10. 实现步骤（有序）

### Step 1：创建工具核心（无外部依赖）

- 新建 `src/runtime/tools/send-media.ts`，实现 `createSendMediaTool(deps)`
- 新建 `src/runtime/tools/send-media.test.ts`，覆盖路径验证、mediaType 推断、mock channel 发送

### Step 2：接入 tool-builder（依赖 Step 1）

- 修改 `src/runtime/agent-manager/tool-builder.ts`
  - `BuildToolsDeps` 增加 `createSendMediaTool?` 字段
  - `buildTools()` 中在 `allowSet.has("send_media")` 时调用它

### Step 3：注册连接（依赖 Step 2）

- 找到 `agentManager.setToolProvider(...)` 的调用点（通常在 kernel 或 host 初始化层）
- 注入 `createSendMediaTool` 工厂，传入懒获取 channel/peerId 的函数：
  - 由于 `setToolProvider` 回调只接收 `{ sessionKey, agentId, workspaceDir, homeDir, sandboxConfig }`，需要在 execution-flow 执行时注册 session context
  - **方案 A（推荐）**：在 `AgentManager` 新增 `registerSessionContext(sessionKey, { channel, peerId })` 和 `getSessionContext(sessionKey)` 方法，在 execution-flow 开始时调用注册
  - **方案 B**：让 tool-provider 回调返回一个函数，在每次 tool 执行时动态获取（需要更复杂的生命周期管理）
- `createSendMediaTool` 的 `getChannel` 和 `getPeerId` 内部调用 `agentManager.getSessionContext(sessionKey)`
- 在 agent config 中为需要 send_media 的 agent 的 `tools` allowlist 添加 `"send_media"`

### Step 4：System Prompt 修复（依赖 Step 3，可与 Step 1-2 并行）

- 修改 `src/runtime/agent-manager/prompt-builder.ts` 的 `buildChannelContext()`
- 增加 `send_media` 是否在已注册 tools 中的过滤逻辑
- 补充使用说明文本

### Step 5：Discord 兼容验证（依赖 Step 3，已完成）

- 已确认 `discord/plugin.ts` 的 `resolveOutboundFiles()` 完整支持 `media[0].buffer` 路径（`discord/plugin.ts:1299-1304`）
- 无需额外改动

---

## 11. 关键设计决策摘要

| 决策 | 选择 | 理由 |
|------|------|------|
| tool name | `send_media` | 与现有 `ChannelActionName`、system prompt 保持一致 |
| 文件读取 | `Bun.file(path).arrayBuffer()` → `Buffer.from()` | 符合项目 Bun 优先约定，不引入 `node:fs` |
| 发送路径 | 直接 `channel.send(peerId, { media })` | 绕过 `dispatchReply` 的 outbound plan negotiation，减少依赖，telegram/send.ts 已完整处理 buffer 路径 |
| 注册位置 | `tool-builder.ts` + `createSendMediaTool` 注入 | 与所有现有工具保持一致，经过 allowList 过滤和 hook 包装 |
| channel/peerId 获取 | 懒绑定闭包（tool 执行时读取 orchestrator 状态） | tool 在 session 初始化时创建，delivery context 在 turn 执行时才确定 |
| localRoots 默认值 | workspace + 标准用户目录 | 覆盖最常见使用场景，可通过 agent config 扩展 |
| allowList 控制 | `send_media` 须显式加入 agent tools allowlist | 避免对不需要媒体功能的 agent 误暴露 |

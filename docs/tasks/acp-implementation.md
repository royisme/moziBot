# ACP (Agent Client Protocol) 实现计划

> 对比参考: `~/software/myproject/ts/openclaw_source_github`
> 基于 2026-02-27 调研 openclaw release 2026.2.26

## 概要

ACP (Agent Client Protocol) 是一个开放协议 ([agentclientprotocol.com](https://agentclientprotocol.com))，让 IDE 和工具通过 stdio NDJSON 消息驱动 agent 会话。在 openclaw 中，ACP 有两个角色：

1. **ACP Bridge** — IDE 集成，让 Zed 等编辑器通过 ACP 协议驱动 agent
2. **ACP Control Plane** — 线程绑定外部 agent，在 Discord/Telegram 线程中启动 Codex、Claude Code 等

---

## Part 1: ACP Control Plane (线程绑定外部 agent)

### 功能描述

允许在聊天线程中启动外部编码 agent。消息路由:

```
Discord/Telegram thread message
  → moziBot 识别线程绑定
  → 转发给 ACP runtime (Codex/Claude Code/...)
  → 流式返回结果到线程
```

### 核心概念

**AcpRuntime** — 可插拔的 agent 后端接口:

```typescript
interface AcpRuntime {
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;
  cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void>;
  close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void>;
  // 可选
  getCapabilities?(input): ...;
  getStatus?(input): Promise<AcpRuntimeStatus>;
  setMode?(input): Promise<void>;
  doctor?(): Promise<AcpRuntimeDoctorReport>;
}
```

**AcpRuntimeEvent** — 流式事件:

```typescript
type AcpRuntimeEvent =
  | { type: "text_delta"; text: string; stream?: "output" | "thought" }
  | { type: "status"; text: string }
  | { type: "tool_call"; text: string }
  | { type: "done"; stopReason?: string }
  | { type: "error"; message: string; code?: string; retryable?: boolean };
```

**Session key 格式**: `agent:<agentId>:acp:<uuid>`

### openclaw 关键文件

| 文件                                     | 职责                                            |
| ---------------------------------------- | ----------------------------------------------- |
| `src/acp/control-plane/manager.core.ts`  | `AcpSessionManager` — 会话生命周期管理          |
| `src/acp/control-plane/manager.types.ts` | 类型: `AcpSessionResolution`, `AcpRunTurnInput` |
| `src/acp/control-plane/manager.ts`       | `getAcpSessionManager()` 单例工厂               |
| `src/acp/control-plane/spawn.ts`         | 失败 spawn 清理: `cleanupFailedAcpSpawn()`      |
| `src/acp/control-plane/runtime-cache.ts` | 运行时会话缓存 + TTL 驱逐                       |
| `src/acp/runtime/types.ts`               | `AcpRuntime` 接口定义                           |
| `src/acp/runtime/registry.ts`            | Backend 注册/查询                               |
| `src/acp/runtime/errors.ts`              | `AcpRuntimeError`                               |
| `src/acp/runtime/session-identifiers.ts` | Session key/cwd 解析                            |
| `src/agents/acp-spawn.ts`                | Agent tool: `spawnAcpDirect()`                  |
| `src/config/types.acp.ts`                | 配置类型                                        |

### 配置结构

```typescript
interface AcpConfig {
  enabled?: boolean; // 全局开关
  dispatch?: { enabled?: boolean }; // turn dispatch 开关
  backend?: string; // e.g. "acpx"
  defaultAgent?: string; // 默认 agent
  allowedAgents?: string[]; // 白名单
  maxConcurrentSessions?: number; // 并发限制
  stream?: {
    coalesceIdleMs?: number; // 流式合并空闲时间
    maxChunkChars?: number; // 最大 chunk 字符数
  };
  runtime?: {
    ttlMinutes?: number; // 会话 TTL
    installCommand?: string; // 安装命令
  };
}
```

### Spawn 流程 (`spawnAcpDirect()`)

1. Policy 检查: `isAcpEnabledByPolicy(cfg)` + `resolveAcpAgentPolicyError()`
2. 解析目标 agent ID (参数或 `acp.defaultAgent`)
3. 生成 session key: `agent:<agentId>:acp:<uuid>`
4. 注册 session: Gateway `sessions.patch`
5. 初始化 runtime: `acpManager.initializeSession()`
6. 线程绑定 (可选): `bindingService.bind(threadId, sessionKey)`
7. 入队首个任务: Gateway `agent`
8. 返回: `{ status: "accepted", childSessionKey, runId, mode }`

### moziBot 实现计划

**Phase 1: 核心类型和 runtime 接口**

```
src/acp/
├── types.ts              # AcpRuntime, AcpRuntimeEvent, AcpConfig 等
├── runtime-registry.ts   # registerBackend(), requireBackend()
├── session-manager.ts    # AcpSessionManager 生命周期管理
├── runtime-cache.ts      # 会话缓存 + TTL
└── index.ts
```

**Phase 2: 线程绑定**

- 新建 `src/runtime/thread-binding/` 或扩展现有 session 管理
- 消息路由: 检查 threadId → 查找 binding → 转发给 ACP runtime
- 需要持久化 binding (SQLite 或 JSON)

**Phase 3: Agent tool**

- `acp_spawn` tool: 让 agent 在对话中启动外部 agent
- 参数: `agent`, `task`, `threadBind`, `cwd`

**Phase 4: Slash commands**

- `/spawn codex <task>` — 启动 Codex 会话
- `/acp status` — 查看活跃会话
- `/acp cancel <id>` — 取消会话

---

## Part 2: ACP Bridge (IDE 集成)

### 功能描述

让 IDE (Zed, VSCode 等) 通过 ACP 协议与 moziBot agent 对话:

```
IDE ← stdio NDJSON → moziBot ACP server ← WebSocket → Agent runtime
```

### 核心组件

**AgentSideConnection** — 实现 ACP agent 端:

```typescript
// ACP prompt → moziBot agent session
// ACP cancel → abort agent session
// ACP listSessions → list active sessions
```

### openclaw 关键文件

| 文件                        | 职责                                               |
| --------------------------- | -------------------------------------------------- |
| `src/acp/server.ts`         | 入口: `serveAcpGateway()`                          |
| `src/acp/translator.ts`     | `AcpGatewayAgent` — 实现所有 ACP agent 方法        |
| `src/acp/session.ts`        | 内存 session store + TTL                           |
| `src/acp/types.ts`          | `AcpSession`, `AcpServerOptions`, `ACP_AGENT_INFO` |
| `src/acp/event-mapper.ts`   | Prompt text/attachment 提取                        |
| `src/acp/session-mapper.ts` | Session key 解析                                   |
| `src/acp/client.ts`         | 调试客户端                                         |
| `src/acp/policy.ts`         | 策略检查                                           |
| `src/acp/commands.ts`       | ACP 命令注册                                       |
| `src/cli/acp-cli.ts`        | CLI: `openclaw acp`                                |
| `docs/cli/acp.md`           | 使用文档                                           |

### SDK 依赖

```json
"@agentclientprotocol/sdk": "0.14.1"
```

### `AcpGatewayAgent` 实现的方法

- `initialize()` — 通告能力 (image support, loadSession 等)
- `newSession()` — 创建新会话
- `loadSession()` — 恢复已有会话
- `unstable_listSessions()` — IDE session picker
- `prompt()` — ACP prompt → agent `chat.send`，返回流式回复
- `cancel()` — 映射到 `chat.abort`
- `setSessionMode()` — 映射到 `sessions.patch` (thinkingLevel)

### 安全措施

- Prompt 大小限制: `MAX_PROMPT_BYTES = 2 * 1024 * 1024` (2MB)
- Policy 检查: `isAcpEnabledByPolicy()`, `isAcpAgentAllowedByPolicy()`

### moziBot 实现计划

**Phase 1: ACP 服务器**

```
src/acp/
├── bridge/
│   ├── server.ts         # serveAcpBridge() — stdio NDJSON 服务
│   ├── translator.ts     # MoziAcpAgent — 翻译 ACP ↔ moziBot
│   ├── session-store.ts  # 内存 session + TTL
│   └── event-mapper.ts   # 事件映射
└── ...
```

**Phase 2: CLI 命令**

- `mozibot acp` — 启动 ACP bridge
- `mozibot acp client` — 调试客户端

**Phase 3: IDE 配置**

- Zed 集成配置文档
- VSCode extension 支持 (如有需求)

---

## 依赖和前提

| 依赖                       | 用途                     | 安装                                    |
| -------------------------- | ------------------------ | --------------------------------------- |
| `@agentclientprotocol/sdk` | ACP 协议 SDK             | `pnpm install @agentclientprotocol/sdk` |
| 线程绑定持久化             | binding session ↔ thread | 利用现有 SQLite 或新建                  |
| Process supervisor         | 管理外部 agent 子进程    | 已实现 (`src/process/`)                 |

## 优先级建议

1. **ACP Control Plane** 优先 — 让 agent 能在线程中启动外部工具，直接可用
2. **ACP Bridge** 其次 — IDE 集成是 developer experience，可以稍后

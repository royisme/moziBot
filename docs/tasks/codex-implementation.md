# Codex (OpenAI Codex) 模型支持实现计划

> 对比参考: `~/software/myproject/ts/openclaw_source_github`
> 基于 2026-02-27 调研 openclaw release 2026.2.26

## 概要

Codex 是 OpenAI 的编码专用模型系列 (`gpt-5.3-codex`)。在 openclaw 中有两种集成方式:

1. **嵌入式 runner** — `openai-codex` 作为模型提供商，WebSocket-first transport
2. **CLI backend** — `codex exec --json` 子进程模式

---

## Part 1: 嵌入式 Runner (WebSocket Transport)

### 功能描述

将 `openai-codex` 注册为模型提供商，使 agent 可以直接使用 Codex 模型进行推理。关键创新是 **WebSocket-first transport** — 默认使用 WebSocket 连接（`"auto"` 模式，降级 SSE）。

### 模型

| 模型 ID | 说明 |
|---|---|
| `openai-codex/gpt-5.3-codex` | 主力 Codex 模型 |
| `openai-codex/gpt-5.3-codex-spark` | 轻量 Codex 模型 (自动合成如果不存在) |

### API 类型

`openai-codex-responses` — 加入 `MODEL_APIS` 联合类型

**关键约束**: Codex Responses API 要求 `store=false`:
```typescript
// 只对 openai-responses / openai / azure-openai-responses 强制 store=true
// Codex responses (chatgpt.com/backend-api/codex/responses) 要求 store=false
const OPENAI_RESPONSES_APIS = new Set(["openai-responses"]);
```

### Transport 选择逻辑

```typescript
// 有效值: "sse" | "websocket" | "auto"
// Codex 默认: "auto" (WebSocket-first, SSE fallback)

function createCodexDefaultTransportWrapper(baseStreamFn) {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      transport: options?.transport ?? "auto",
    });
}

// 当 provider === "openai-codex" 时应用:
if (provider === "openai-codex") {
  agent.streamFn = createCodexDefaultTransportWrapper(agent.streamFn);
}
```

**Override 优先级**: `options.transport` (运行时) > `params.transport` (配置) > `"auto"` (Codex 默认) > `undefined` (非 Codex)

### OAuth 登录

```typescript
// src/commands/openai-codex-oauth.ts
loginOpenAICodexOAuth()
// 使用 @mariozechner/pi-ai 的 OAuth 流程
// 获取 bearer token 用于 API 调用
```

### Usage 统计

```typescript
// src/infra/provider-usage.fetch.codex.ts
fetchCodexUsage()
// 从 https://chatgpt.com/backend-api/wham/usage 获取
// Headers: Authorization: Bearer <token>, ChatGPT-Account-Id (可选)
// 返回: primary/secondary rate limit windows + credit balance
```

### openclaw 关键文件

| 文件 | 职责 |
|---|---|
| `src/agents/pi-embedded-runner/extra-params.ts:244-251,671-674` | Codex transport wrapper |
| `src/agents/pi-embedded-runner-extraparams.test.ts` | Transport 选择回归测试 |
| `src/agents/model-catalog.ts` | Codex 模型目录 + spark fallback |
| `src/agents/model-selection.ts` | `OPENAI_CODEX_OAUTH_MODEL_PREFIXES` |
| `src/infra/provider-usage.fetch.codex.ts` | Usage 统计 |
| `src/commands/openai-codex-model-default.ts` | `applyOpenAICodexModelDefault()` |
| `src/commands/openai-codex-oauth.ts` | OAuth 登录 |
| `src/config/types.models.ts` | `openai-codex-responses` 在 MODEL_APIS 联合类型中 |

### moziBot 实现计划

**Phase 1: 模型提供商注册**
- 在模型配置 schema 中增加 `openai-codex-responses` API 类型
- 在模型目录中注册 `gpt-5.3-codex` 和 `gpt-5.3-codex-spark`
- 确保 `store=false` 约束

**Phase 2: Transport 支持**
- 在 streaming 层增加 WebSocket transport 支持
- 实现 `"auto"` 模式: WebSocket-first, SSE fallback
- 当 provider 是 `openai-codex` 时，默认使用 `"auto"`

**Phase 3: OAuth + Usage**
- 实现 `loginOpenAICodexOAuth()` 命令
- 实现 `fetchCodexUsage()` 统计
- 配置存储 token

---

## Part 2: CLI Backend (子进程模式)

### 功能描述

通过子进程运行 `codex` CLI 二进制，以 JSONL 格式交互:

```typescript
const DEFAULT_CODEX_BACKEND = {
  command: "codex",
  args: [
    "exec", "--json", "--color", "never",
    "--sandbox", "read-only",
    "--skip-git-repo-check"
  ],
  resumeArgs: [
    "exec", "resume", "{sessionId}",
    "--color", "never",
    "--sandbox", "read-only",
    "--skip-git-repo-check"
  ],
  output: "jsonl",          // JSONL 输出格式
  resumeOutput: "text",     // resume 时纯文本输出
  input: "arg",             // 输入通过命令行参数
  modelArg: "--model",      // 模型参数
  sessionIdFields: ["thread_id"],  // session ID 来源字段
  sessionMode: "existing",  // 使用已有 session
  imageArg: "--image",      // 图片参数
  imageMode: "repeat",      // 多图: 重复 --image 参数
  serialize: true,          // 串行执行
};
```

### 默认模型设置

```typescript
// src/commands/openai-codex-model-default.ts
function applyOpenAICodexModelDefault() {
  // 设置 agents.defaults.model = "openai-codex/gpt-5.3-codex"
}
```

### Spark Fallback

```typescript
// src/agents/model-catalog.ts
function applyOpenAICodexSparkFallback() {
  // 如果 catalog 有 gpt-5.3-codex 但没有 gpt-5.3-codex-spark
  // 自动合成 spark 条目
}
```

### openclaw 关键文件

| 文件 | 职责 |
|---|---|
| `src/agents/cli-backends.ts` | `DEFAULT_CODEX_BACKEND` 配置 |
| `src/commands/openai-codex-model-default.ts` | 默认模型设置 |
| `src/agents/model-catalog.ts` | Spark fallback 逻辑 |

### moziBot 实现计划

**Phase 1: CLI backend 框架**
- 如果 moziBot 还没有 CLI backend 概念，需要新建 `src/runtime/cli-backend/`
- 实现子进程管理 (可复用 `src/process/supervisor.ts`)
- 实现 JSONL 输出解析

**Phase 2: Codex backend 配置**
- 注册 `codex` CLI backend
- 实现 `resume` 会话恢复
- 实现 `--image` 参数支持

---

## 与 ACP 的关系

Codex 可以通过两种方式接入 moziBot:

1. **嵌入式** (Part 1) — moziBot 直接调用 Codex API，agent 使用 Codex 作为模型
2. **CLI + ACP** (Part 2 + ACP) — moziBot 通过 ACP Control Plane 启动 `codex` CLI 进程，绑定到线程

两者不冲突，可以并行存在:
- 嵌入式用于: agent 内部推理，用 Codex 模型替代其他模型
- CLI + ACP 用于: 在线程中启动独立的 Codex agent 实例

## 依赖

| 依赖 | 用途 | 说明 |
|---|---|---|
| `@mariozechner/pi-ai` | OAuth + streaming | 检查 moziBot 是否已有 |
| `codex` CLI | 子进程后端 | 用户机器上需安装 |
| WebSocket 支持 | transport | Bun 内置 `WebSocket` |

## 优先级建议

1. **嵌入式 runner** (Part 1) — 最直接有用，让 agent 能使用 Codex 模型
2. **CLI backend** (Part 2) — 需要与 ACP 配合，建议在 ACP Control Plane 之后实现

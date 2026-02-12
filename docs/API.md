# Mozi API Reference

## Core Interfaces

### Agent Session

The `AgentSession` is the primary interface for interacting with agents.

```typescript
interface AgentSession {
  // Core properties
  readonly messages: AgentMessage[];
  readonly systemPrompt: string;

  // Message operations
  replaceMessages(messages: AgentMessage[]): void;
  setSystemPrompt(prompt: string): void;

  // Execution
  prompt(text: string): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  compact(): Promise<{ tokensBefore: number }>;

  // Lifecycle
  dispose(): void;
}
```

### Message Types

```typescript
interface AgentMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | MessageContent[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

interface MessageContent {
  type: "text" | "image" | "file";
  text?: string;
  imageUrl?: { url: string };
  fileData?: { mimeType: string; data: string };
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
```

### Tool Definition

```typescript
interface AgentTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (args: unknown) => Promise<unknown>;
}
```

### Channel Plugin

```typescript
interface ChannelPlugin {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;

  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  send(peerId: string, message: OutboundMessage): Promise<void>;
  editMessage?(messageId: string, peerId: string, text: string): Promise<void>;

  onMessage(handler: (message: InboundMessage) => void): void;
}

interface ChannelCapabilities {
  supportsMedia: boolean;
  supportsThreads: boolean;
  supportsEditing: boolean;
}
```

## Runtime APIs

### AgentManager

```typescript
class AgentManager {
  // Agent lifecycle
  getAgent(sessionKey: string, agentId?: string): Promise<ResolvedAgent>;
  resetSession(sessionKey: string, agentId?: string): void;

  // Context management
  updateSessionContext(sessionKey: string, messages: unknown): void;
  getSessionMetadata(sessionKey: string): Record<string, unknown> | undefined;
  updateSessionMetadata(sessionKey: string, metadata: Record<string, unknown>): void;

  // Model switching
  setSessionModel(sessionKey: string, modelRef: string): Promise<void>;

  // Tools
  buildTools(params: ToolBuildParams): Promise<AgentTool[]>;
}
```

### MessageHandler

```typescript
class MessageHandler {
  constructor(config: MoziConfig, deps?: HandlerDependencies);

  // Message processing
  handleMessage(message: InboundMessage, options: HandleOptions): Promise<HandleResult>;

  // Commands
  handleCommand(sessionKey: string, command: string, args: string): Promise<CommandResult>;

  // Lifecycle
  reloadConfig(config: MoziConfig): Promise<void>;
  shutdown(): Promise<void>;
}
```

## Configuration Schema

### Full Config Type

```typescript
interface MoziConfig {
  $schema?: string;
  $include?: string | string[];

  meta?: {
    version?: string;
    createdAt?: string;
  };

  paths?: {
    baseDir?: string;
    sessions?: string;
    logs?: string;
    skills?: string;
    workspace?: string;
  };

  models?: {
    providers?: Record<string, ModelProvider>;
  };

  agents?: {
    defaults?: AgentDefaults;
    [agentId: string]: AgentConfig | undefined;
  };

  channels?: {
    routing?: ChannelRouting;
    telegram?: TelegramConfig;
    discord?: DiscordConfig;
  };

  sandbox?: SandboxConfig;
  extensions?: ExtensionsConfig;
}
```

### Model Provider

```typescript
interface ModelProvider {
  baseUrl?: string;
  apiKey?: string;
  api?: "openai-responses" | "openai-completions" | "anthropic-messages" | "google-generative-ai";
  headers?: Record<string, string>;
  models: Array<{
    id: string;
    contextWindow?: number;
    maxTokens?: number;
    input?: ("text" | "image" | "audio" | "video" | "file")[];
  }>;
}
```

## Extension API

### Extension Manifest

```typescript
interface ExtensionManifest {
  id: string;
  name: string;
  version: string;

  tools?: Array<{
    name: string;
    description: string;
    parameters: object;
    handler: string;
  }>;

  hooks?: {
    onInit?: string;
    onShutdown?: string;
    onMessage?: string;
  };
}
```

### Extension Context

```typescript
interface ExtensionContext {
  logger: Logger;
  config: MoziConfig;

  registerTool(tool: AgentTool): void;
  registerHook(event: string, handler: Function): void;

  getAgent(sessionKey: string): Promise<AgentSession>;
}
```

## Events

### Agent Events

```typescript
type AgentEvent =
  | { type: "prompt_start"; sessionKey: string; text: string }
  | { type: "prompt_complete"; sessionKey: string; durationMs: number }
  | { type: "tool_call"; sessionKey: string; toolName: string; args: unknown }
  | { type: "tool_result"; sessionKey: string; toolName: string; result: unknown }
  | { type: "error"; sessionKey: string; error: Error };
```

### Channel Events

```typescript
interface InboundMessage {
  id: string;
  channelId: string;
  peerId: string;
  senderId: string;
  text: string;
  timestamp: Date;
  media?: MediaAttachment[];
  replyTo?: string;
}

interface OutboundMessage {
  text: string;
  media?: MediaAttachment[];
  replyTo?: string;
}
```

## Utility Functions

### Context Management

```typescript
// Prune messages to fit context window
function pruneContextMessages(params: {
  messages: AgentMessage[];
  settings: PruningSettings;
  contextWindowTokens: number;
}): { messages: AgentMessage[]; stats: PruningStats };

// Estimate token count
function estimateMessagesTokens(messages: AgentMessage[]): number;
function estimateTokens(text: string): number;
```

### Session Utils

```typescript
// Build session key
function buildSessionKey(params: {
  agentId: string;
  channelId: string;
  peerId: string;
  scope?: string;
}): string;

// Parse session key
function parseSessionKey(sessionKey: string): {
  agentId: string;
  channelId: string;
  peerId: string;
};
```

## Error Types

```typescript
class AgentError extends Error {
  constructor(message: string, public code: string, public cause?: Error);
}

class ContextOverflowError extends AgentError {
  constructor(public tokenCount: number, public limit: number);
}

class ToolExecutionError extends AgentError {
  constructor(public toolName: string, public args: unknown, cause: Error);
}

class ModelUnavailableError extends AgentError {
  constructor(public modelRef: string, cause?: Error);
}
```

## Type Guards

```typescript
function isAgentMessage(obj: unknown): obj is AgentMessage;
function isToolCall(obj: unknown): obj is ToolCall;
function isTextContent(obj: unknown): obj is { type: "text"; text: string };
function isContextOverflowError(err: unknown): err is ContextOverflowError;
```

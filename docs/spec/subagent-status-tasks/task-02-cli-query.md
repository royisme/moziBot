# Task 02: CLI inspection for detached subagent runs

## 目标
提供 `subagent list` 与 `subagent status <runId>` 两个只读 CLI 命令，直接基于 `DetachedRunRegistry` 持久化数据查询 detached subagent run 状态。

## 范围文件
- `src/cli/commands/subagent-list.ts`（新建）
- `src/cli/commands/subagent-status.ts`（新建）
- `src/cli/commands/acp.ts` 或 CLI 命令注册入口（修改）
- 可能需要的 CLI 测试文件

## 依赖
- 依赖 Task 01 提供的 registry 数据模型与 phase 去重字段，确保 CLI 能展示完整生命周期可见性信息。

## 实现要点
- 复用 detached run 持久化文件及其数据模型，只查询 `kind = "subagent"` 的记录；ACP 记录不得通过 subagent CLI 暴露。
- `subagent list` 以创建时间倒序展示 runId、status、任务摘要和关键时间戳；无记录时给出明确提示。
- `subagent status <runId>` 展示单条记录的详细状态、时间戳、timeout、result/error 摘要及已通知 phase 信息。
- 参考 `src/cli/commands/acp-status.ts` 的输出风格处理人类可读展示与错误退出；如实现 JSON 输出，应保持字段稳定且与 registry 命名一致。
- 对不存在的 `runId`、类型不匹配记录返回非零退出并提供明确错误信息。

## 验收标准
1. `subagent list` 能列出所有 detached subagent runs，并按时间倒序展示核心状态。
2. `subagent status <runId>` 能准确展示单个 detached subagent run 的详情。
3. 对不存在的 runId 或非 subagent runId，CLI 给出明确错误并非零退出。
4. CLI 输出不依赖额外缓存、服务或新数据源。
5. 测试命令：`pnpm run test`

## 注意事项
- 不实现 `subagent abort`。
- 输出应帮助用户把 CLI 查询与 runtime 通知串联起来，例如保留 `runId` 可见性。

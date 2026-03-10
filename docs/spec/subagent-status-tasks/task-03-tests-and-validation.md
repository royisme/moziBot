# Task 03: Tests and validation for subagent status visibility

## 目标
补齐 detached subagent lifecycle visibility 与 CLI inspection 的回归测试，确保通知去重、持久化恢复和命令行查询行为稳定。

## 范围文件
- `src/runtime/host/sessions/subagent-registry.integration.test.ts`
- `src/runtime/host/sessions/*.test.ts` 中与 detached run 相关的测试
- `src/cli/commands/*.test.ts` 中新增或扩展的 subagent CLI 测试
- 如需新增专用测试文件，可按现有命名模式创建

## 依赖
- 依赖 Task 01 完成 runtime 生命周期可见性。
- 依赖 Task 02 完成 CLI 查询命令与注册。

## 实现要点
- 增加 runtime 测试，覆盖 accepted / started / streaming / terminal phase 的一次性通知行为，特别是 `streaming` 多次 delta 只提示一次。
- 增加持久化恢复测试，验证 registry restore 后 phase 去重元数据仍然生效，不会在 host 重启后重复提示已发送 phase。
- 增加 CLI 测试，覆盖 `subagent list` 有记录/无记录、`subagent status` 成功/未找到/类型不匹配等分支。
- 保留现有 detached terminal announce、ACP 查询、subagent registry reconcile 的回归覆盖，确保本功能不破坏既有 detached runtime 能力。
- 所有测试应以可验证行为为主，不依赖人工检查日志。

## 验收标准
1. 自动化测试覆盖生命周期 phase 去重、重启恢复、CLI 查询与错误处理。
2. 现有 subagent detached runtime 与 ACP 相关测试不因本功能回归。
3. 运行 `pnpm run test` 通过。
4. 如涉及格式或类型变更，`pnpm run check` 与 `npx tsc --noEmit` 也应通过。

## 注意事项
- 重点验证 `DetachedRunRegistry remains sole source of truth` 的实现结果，而非只验证命令输出格式。
- 若终态 announce 与 phase 提示共存，测试需明确两者职责不同，避免把自然语言总结误判成 phase 提示重复。

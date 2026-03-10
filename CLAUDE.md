## 技术栈
- 需要了解运行时/依赖 → 查 `package.json`
- 需要了解 Bun API → 查 `node_modules/bun-types/docs/`
- 包管理用 `pnpm`，运行脚本用 `pnpm run <script>`

## 命令
- 检查（lint+format）：`pnpm run check`
- 测试：`pnpm run test`
- 类型检查（check 不含）：`npx tsc --noEmit`
- git hooks：pre-commit → check，pre-push → test

## MCP 工具
- 开始任务前先确认当前会话可用的 MCP 工具列表
- 输出量大的命令 → 用压缩类 MCP，而非直接 Bash
- 第三方库文档 → 用文档查询类 MCP
- 代码符号操作 → 用符号级 MCP

## 行为规范
- 意图清晰且可逆 → 直接执行，事后简述
- 不可逆 / 生产副作用 / 缺关键信息 → 先确认
- 多步骤：改一步，验一步

## 排障经验
遇到问题先查 `.claude/troubleshooting.md`；解决问题后将根因和修复方式补充到该文件对应分类。

## 功能设计文档
- spec：`docs/spec/<feature>.md`（what/why）
- 实现指南：`docs/spec/<feature>-impl.md`（how）
- 子任务：`docs/spec/<feature>-tasks/task-0N-<name>.md`
- 完成后重命名为 `task-0N-<name>.resolved.md`；无 `.resolved` = 未完成

**Subagent 分工：**
- 调研/验证/简单修改 → `selfwork:haiku-dev`
- spec / task 文档生成 → `selfwork:architect`
- 复杂多文件实现 → `selfwork:sonnet-dev`
- TS 类型错误修复 → `selfwork:ts-js-expert`

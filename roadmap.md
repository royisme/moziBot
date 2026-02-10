# Mozi Roadmap

> 单一来源：项目规划与当前状态
> 更新: 2026-02-05

---

## 已实现 ✅

### 基础设施

- [x] Bun 项目初始化 + TypeScript strict
- [x] Biome linting/formatting
- [x] 日志基础设施 (pino)
- [x] JSONC 配置加载（$include、环境变量替换）
- [x] Config 校验与 doctor（`mozi config`, `mozi doctor`）
- [x] SQLite 数据库（bun:sqlite）

### Agent 核心

- [x] pi-agent-core 集成（Agent 运行时）
- [x] Provider/Model 注册表
- [x] Agent Manager（per-session model 锁定、fallback）
- [x] Home/Workspace 上下文加载（Home: AGENTS/SOUL/IDENTITY/USER/MEMORY; Workspace: TOOLS.md）
- [x] Sandbox exec 工具（Docker）
- [x] Skills 自动加载 + Home Skills Index
- [x] Session 管理（JSONL transcripts）
- [x] 持久化 Session Store（sessions.json）
- [x] Heartbeat Runner（HEARTBEAT.md + channel send）

### Channel 集成

- [x] Telegram 插件（grammy）
- [x] Discord 插件（基础）
- [x] Runtime Host 路由（channel-based agent 选择）
- [x] Session Key 构建（dmScope + thread suffix）

### CLI

- [x] `mozi chat` TUI
- [x] `mozi runtime start/stop/status`

### Memory 系统 (2026-02-04)

- [x] Memory 接口定义（types.ts）
- [x] Builtin Backend（SQLite FTS5 + LIKE fallback）
- [x] Fallback Manager（QMD → Builtin 降级）
- [x] QMD Manager（外部 CLI 集成）
- [x] memory_search / memory_get 工具
- [x] Per-Agent 隔离 + Scope 控制
- [x] Session 导出 + 清理

---

## 进行中 🚧

### Memory 集成

- [x] 集成到 Agent Runtime
- [ ] 端到端测试

### CLI 完善

- [ ] `mozi init` TUI 向导
- [ ] `mozi config` TUI 编辑器
- [ ] Config JSON Schema 生成

### 已知问题

- [ ] CLI runtime 命令仍引用 `mozi.config.json` 而非 `~/.mozi/config.jsonc`

---

## 计划中 📋

### Phase 1: 稳定性

- [ ] Session Store 加固（锁定、并发写入）
- [ ] Token 预算控制（workspace context）
- [ ] 错误处理增强
- [ ] 速率限制

### Phase 2: Sandbox

- [ ] Sandbox Runtime 实现（目前仅接口）
- [ ] Docker 容器隔离
- [ ] Volume 挂载系统
- [ ] 超时处理

### Phase 3: 扩展性

- [ ] Skill 发现
- [x] 扩展加载器（skills loader）
- [ ] 自定义工具注册
- [ ] 事件钩子

### Phase 4: 高级功能

- [ ] Cron 任务调度
- [ ] web_search / web_fetch
- [ ] 可选浏览器自动化

### Phase 5: 生产就绪

- [ ] 安全加固（挂载白名单、审计日志）
- [ ] 热重载
- [ ] API 文档
- [ ] 部署指南

---

## 未来考虑 🔮

- WhatsApp 集成（Baileys）
- Web Dashboard
- 多 Agent 协调（sub-agent spawning）
- Apple Container Runtime

---

## 成功指标

| 阶段   | 指标                        | 状态 |
| ------ | --------------------------- | ---- |
| 基础   | Agent 响应 Telegram 消息    | ✅   |
| 多通道 | Telegram + Discord 都能工作 | ✅   |
| Memory | 语义搜索工作正常            | 🚧   |
| 调度   | 定时任务可靠运行            | 📋   |
| 稳定   | 连续 7 天稳定运行           | 📋   |

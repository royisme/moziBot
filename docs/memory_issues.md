# Memory Issues Analysis

## Core Problem

当前 memory 体系的方向是对的，但还不够工程化。主要问题不是“有没有记忆”，而是“记忆如何被筛选、分层、整理、提升”。

现状更像是一个会持续积累内容的系统，而不是一个能够稳定产出高质量长期记忆的系统。其直接后果是：

- 长期记忆被短期噪音污染
- 检索命中率下降，真正重要的偏好和规则被淹没
- agent 难以区分稳定事实、临时状态、一次性上下文
- memory 随时间增长后，维护和蒸馏成本持续上升

## Primary Issues

### 1. Lack of layered write strategy

当前缺少明确的 memory 分层职责，导致不同类型的信息被混写。

典型表现：

- 琐碎会话内容进入长期记忆
- 长期规则散落在 daily/raw memory 中
- 工作产出、研究分析、运行态信息混入同一层
- session 临时状态被错误持久化

本质上，系统没有回答清楚以下问题：

- 什么应该写 daily memory
- 什么应该写长期 `MEMORY.md`
- 什么应该写工作文档 / docs / Obsidian
- 什么根本不应持久化

### 2. Lack of memory recycling / distillation

当前更偏向原样累积，而不是定期整理和蒸馏。

这会导致：

- daily memory 越积越多，但长期知识没有被提纯
- 过时状态和一次性决策长期残留
- memory 检索质量随时间下降
- 真正稳定的经验没有被提炼成规则化表达

结论：不是记得越多越好，而是长期记忆越干净越好。

### 3. Raw transcript leakage into long-term memory

`MEMORY.md` 中混入原始对话、催促语句、一次性链接、情绪化原话，会明显降低长期记忆质量。

这些内容的问题：

- 噪音高，复用价值低
- 不利于 agent 做抽象决策
- 容易让后续检索命中无关内容
- 难以判断哪些是稳定偏好，哪些只是单次上下文

长期记忆应该保存“规则化结论”，而不是“聊天转储”。

### 4. No structured write pipeline

目前 memory 写入更像 agent 直接落盘，而不是经过策略控制的写入管道。

缺失的关键能力包括：

- 候选记忆结构化表示
- 分类与作用域判断
- validator 拦截低质量写入
- promotion 评分与门槛
- 去重、合并、compact、prune 机制

没有中间层，就很难稳定约束写入质量。

## Recommended Layering Model

### A. Daily memory

建议定位为：**原始但经过摘要的短期记忆 / 当天上下文事件**。

适合写入：

- Decisions
- Active Work
- Lessons
- TODO
- Blockers

不应写入：

- 逐句聊天记录
- 情绪化重复催促
- 无后续价值的闲聊
- 纯 URL 或临时报错全文

关键原则：daily memory 记录“摘要事件”，不是 transcript。

### B. Long-term `MEMORY.md`

建议定位为：**长期稳定记忆 / 已确认高价值规则**。

只写入：

- User Preferences
- Stable Rules
- Tooling Facts
- Long-term Projects
- Repeated Lessons

不应写入：

- 单次任务状态
- 一次性链接
- 临时端口/环境状态
- 原始聊天流水账
- 无法复用的执行细节

关键原则：长期记忆必须是“规则化表述”。

### C. Workspace docs / Obsidian

建议定位为：**知识资产与工作文档**。

适合写入：

- 研究笔记
- 方案设计
- 项目分析
- README / 设计文档
- 可复用外部资料整理

不适合写入：

- agent 内部短期运行态
- 每轮会话碎片
- 临时任务接续状态

## Recommended Write Triggers

### Must write to daily memory

以下情况应进入 daily memory：

- 用户明确说“记住这个”
- 用户明确说“以后按这个来”
- 用户明确说“不要再这样做”
- 出现已确认决策（路径、工具、流程、profile、端口等）
- 出现值得避免的失败经验
- 有需要跨会话接续的 active work / blocker

### Promote to long-term memory only when stable

以下情况才应提升到 `MEMORY.md`：

- 明确属于未来高概率复用的信息
- 用户明确确认的长期偏好/长期约束
- 稳定工具链或环境结论
- 已重复出现的经验或规则
- 能显著提升后续决策质量

### Keep out of memory

以下内容应只存在于工作文档或 session：

- 详细方案正文
- 长文分析
- repo 级实施细节
- 外部资料摘录
- 一次性状态或过期上下文

## Recommended Data Flow

建议把 memory 写入改成受控管道：

`conversation -> extractor -> candidate memory -> validator/ranker -> writer -> files`

### Suggested stages

1. **Memory extraction**
   从当前 turn 提取候选事件，而不是直接写 markdown。

2. **Candidate structuring**
   先生成结构化对象，例如：scope、category、summary、confidence、tags、promoteCandidate。

3. **Policy validation**
   根据 scope 和 category 做硬规则校验，拦截低价值内容。

4. **Daily write**
   将通过校验的高价值短期事件写入 daily memory。

5. **Promotion**
   只有高分且稳定的候选内容才允许进入 `MEMORY.md`。

6. **Maintenance**
   定期做 dedupe、merge、compact、prune。

## Validation Rules

### Daily validator should allow

- `decision`
- `lesson`
- `active_work`
- `todo`
- `blocker`

### Daily validator should reject

- 超长原文转录
- 连续多条 `User:` / `Assistant:` transcript
- 纯 URL dump
- 情绪性原话原样保存

### Long-term validator should allow

- `user_preference`
- `stable_rule`
- `tooling_fact`
- `long_term_project`
- `repeated_lesson`

### Long-term validator should reject

- `active_work`
- 单次任务状态
- 原始聊天记录
- 临时链接/端口/一次性上下文

## Promotion Rules

长期记忆不应每个 turn 自动写入，应设置更高门槛。

可采用评分机制，例如：

- explicit remember: `+5`
- user preference: `+4`
- repeated multiple times: `+4`
- confirmed tooling fact: `+3`
- single task state: `-4`
- raw transcript: `-10`

只有超过阈值的内容才允许进入 `MEMORY.md`。

## Output Format Recommendations

### Daily template

```md
## YYYY-MM-DD

### Decisions
- ...

### Active Work
- ...

### Lessons
- ...

### TODO
- ...
```

### Long-term template

```md
## User Preferences
- ...

## Stable Rules
- ...

## Tooling Facts
- ...

## Long-term Projects
- ...

## Repeated Lessons
- ...
```

核心要求：模板化写入，不允许自由 append 原始聊天内容。

## Most Important Design Conclusion

最关键的问题不是 prompt 不够强，而是缺少程序化约束。

仅靠 agent 自觉遵守，很难长期稳定地维护高质量 memory。更可靠的方向是：

- 收口写入入口
- 引入候选层（inbox / jsonl）
- 增加 validator / ranker / promoter
- 将 daily 和 long-term 分开治理
- 用 maintenance job 做定期蒸馏和清理

## Recommended Next-Step Framing

后续分析可围绕以下核心问题展开：

1. 如何定义 memory pipeline 的模块边界？
2. candidate memory 的数据结构应该是什么？
3. validator / scorer / promoter 的规则如何设计？
4. daily memory 与 long-term memory 的落盘机制如何解耦？
5. compact / dedupe / prune 应由何处触发？
6. 如何防止 agent 直接写正式 memory 文件？

## Suggested Mozi Integration

在 mozi 中，可以考虑拆为以下模块：

- `MemoryExtractionService`
- `MemoryPolicyEngine`
- `MemoryStore`
- `DailyMemoryWriter`
- `LongTermPromotionService`
- `MemoryMaintenanceJob`

一个合理的事件流可以是：

`TurnCompletedEvent -> MemoryExtractionService -> CandidateMemory[] -> MemoryPolicyEngine -> DailyMemoryWriter -> LongTermPromotionService`

这会比“让 agent 随手写 memory”稳定得多，也更适合长期演化。

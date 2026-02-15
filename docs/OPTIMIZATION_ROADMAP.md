# Optimization Roadmap

This document tracks potential optimizations and improvements for the Mozi codebase. Items are prioritized by impact and effort.

---

## High Priority

### 1. Skill Loading Optimization

**Current State:**
- All skills are loaded into the system prompt at once
- With 5 bundled skills, this consumes ~2-3k tokens per request
- Skills are static markdown files loaded at runtime

**Problem:**
As the skill ecosystem grows (>10 skills), token consumption becomes significant, increasing API costs and potentially hitting context window limits.

**Proposed Solutions:**

#### Option A: On-Demand Skill Loading (Recommended)
- Implement a skill router that selects relevant skills based on user intent
- Only load 1-3 most relevant skills per request
- Use embeddings to match user queries with skill descriptions

**Implementation:**
```typescript
// New: SkillRouter
interface SkillRouter {
  selectSkills(query: string, availableSkills: Skill[]): Promise<Skill[]>;
}

// System prompt would only include:
// - Core skills (always loaded)
// - Dynamically selected skills based on query
```

**Benefits:**
- Reduces token usage by 60-80% for typical queries
- Allows unlimited skill ecosystem growth
- Lower API costs

**Effort:** Medium

#### Option B: Hierarchical Skill System
- Split skills into "core" (always loaded) and "extended" (on-demand)
- Core: web-search, create-skills
- Extended: domain-specific skills loaded when needed

**Effort:** Low

#### Option C: Skill Summaries
- Generate condensed summaries of each skill
- Load full skill documentation only when needed
- Use LLM to compress skill content

**Effort:** Low-Medium

---

## Medium Priority

### 2. Session Manager Skill (Requires System Development)

**Current State:**
- Session history is stored in JSONL files and SQLite
- No programmatic access to search session history
- Users cannot query past conversations

**Goal:**
Enable the agent to search and reference previous conversations.

**Required Development:**

#### New Tools Needed:
```typescript
// src/runtime/tools/session-tools.ts
interface SessionSearchTool {
  name: "session_search";
  parameters: {
    query?: string;
    agentId?: string;
    channel?: string;
    status?: SessionStatusValue;
    timeRange?: { from?: string; to?: string };
    limit?: number;
  };
}

interface SessionHistoryTool {
  name: "session_history";
  parameters: {
    sessionKey: string;
    limit?: number;
    before?: string;
  };
}
```

#### Implementation Steps:
1. Create `src/runtime/tools/session-tools.ts`
2. Add session search repository methods in `src/storage/repos/sessions.ts`
3. Integrate into `src/runtime/agent-manager/tool-builder.ts`
4. Create bundled skill: `src/agents/skills/bundled/session-manager/`

**Effort:** Medium (2-3 days)

**Benefits:**
- Conversation continuity across sessions
- Context recovery for returning users
- Better user experience for long-term relationships

---

### 3. Tool Discovery and Dynamic Loading

**Current State:**
- Tools are hardcoded in `tool-builder.ts`
- Extensions can register tools, but no dynamic discovery
- All enabled tools are always available

**Goal:**
Allow agents to discover and request specific tools as needed.

**Proposed Implementation:**
```typescript
// Tool registry with metadata
interface ToolRegistry {
  name: string;
  description: string;
  parameters: JSONSchema;
  requires?: {
    bins?: string[];
    env?: string[];
    extensions?: string[];
  };
}

// Agent can request tool activation
{
  tool: "request_tool",
  parameters: {
    toolName: "github_cli",
    reason: "User wants to create a PR"
  }
}
```

**Effort:** Medium

---

## Low Priority

### 4. Memory Index Optimization

**Current State:**
- Memory search uses full-text + embedding hybrid
- No caching of embedding results
- Each search recomputes embeddings

**Optimizations:**
- Cache embedding vectors for frequently accessed memories
- Implement incremental indexing for new memories
- Add memory categorization/tags for faster filtering

**Effort:** Low-Medium

---

### 5. Parallel Tool Execution

**Current State:**
- Tools execute sequentially
- Independent tools could run in parallel

**Goal:**
Execute non-dependent tools concurrently to reduce latency.

**Example:**
```typescript
// Current: sequential (~3s total)
const weather = await weatherTool.execute();
const news = await newsTool.execute();

// Optimized: parallel (~1.5s total)
const [weather, news] = await Promise.all([
  weatherTool.execute(),
  newsTool.execute()
]);
```

**Considerations:**
- Need dependency graph analysis
- Resource contention for sandbox/exec tools
- Error handling complexity

**Effort:** Medium-High

---

### 6. Context Window Management

**Current State:**
- Context compaction happens when window is full
- No predictive trimming

**Improvements:**
- Predictive context trimming based on message patterns
- Smart preservation of critical context (user preferences, key facts)
- Compress older messages more aggressively than recent ones

**Effort:** Medium

---

## Deferred / Future

### 7. Multi-Model Routing

**Goal:**
Route different tasks to different models based on complexity and cost.

**Example:**
- Simple Q&A → Fast/cheap model
- Complex coding → Strongest model
- Skill selection → Lightweight model

**Requires:**
- Model capability registry
- Task complexity estimation
- Cost/latency trade-off logic

**Effort:** High

---

### 8. Persistent Agent State

**Goal:**
Maintain agent state across restarts (working memory, current task, etc.)

**Current:**
- Agent state is ephemeral per session
- No long-term agent memory

**Effort:** High

---

## Implementation Guidelines

When implementing optimizations:

1. **Measure first** - Profile current performance before optimizing
2. **Maintain compatibility** - Don't break existing skill/tool interfaces
3. **Feature flags** - Use config flags for new behaviors
4. **Test coverage** - Add integration tests for new features
5. **Document changes** - Update AGENTS.md and relevant docs

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-15 | Keep 5 bundled skills | Good balance of utility vs. token usage |
| 2026-02-15 | Defer session-manager | Requires system tool development |
| 2026-02-15 | Prioritize skill routing | High impact on scalability |

---

## Related Documents

- `docs/ARCHITECTURE.md` - System architecture overview
- `docs/TECH_STACK.md` - Technology choices
- `.works/task_014_agent_manager_kernel_split_plan.md` - Recent refactoring

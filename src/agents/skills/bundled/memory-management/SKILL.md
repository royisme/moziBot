---
name: memory-management
description: Manage long-term memory and knowledge base using memory_search and memory_get tools.
---

# Memory Management

Use this skill to interact with the long-term memory and knowledge base system.

## When To Use

- "search my notes about..."
- "what do I know about..."
- "add this to my knowledge base"
- "find related information"
- "summarize my documents"

## Available Tools

### memory_search

Search the knowledge base for relevant information.

```typescript
{
  query: "project requirements",
  maxResults: 10,
  minScore: 0.7
}
```

### memory_get

Retrieve specific memory files by path.

```typescript
{
  relPath: "projects/client-a/specs.md";
}
```

## Search Strategies

### Semantic Search

For conceptual queries, use natural language:

```typescript
memory_search({
  query: "authentication implementation approaches",
  maxResults: 5,
});
```

### Keyword Search

For specific terms:

```typescript
memory_search({
  query: "API_KEY environment variable",
  maxResults: 10,
});
```

### Filtered Search

Combine with context:

```typescript
memory_search({
  query: "deployment process",
  maxResults: 8,
  minScore: 0.8, // Higher relevance threshold
});
```

## Common Workflows

### Finding Project Information

```typescript
// Search for architecture docs
const results = await memory_search({
  query: "system architecture design",
  maxResults: 5,
});

// Read full document if found
if (results[0]) {
  await memory_get({ relPath: results[0].path });
}
```

### Context Recovery

When user references past discussions:

```typescript
// Search for previous context
await memory_search({
  query: "user requirement about notification system",
  maxResults: 10,
});
```

### Knowledge Discovery

Find related information:

```typescript
// Find all documents about a topic
await memory_search({
  query: "database migration",
  maxResults: 20,
});
```

## Output Format

Search results include:

- **path**: File location in memory
- **score**: Relevance score (0-1)
- **snippet**: Preview of content
- **metadata**: Timestamps, tags, etc.

## Best Practices

1. **Start broad**, then narrow down
2. **Use specific keywords** for technical terms
3. **Check multiple results** for comprehensive view
4. **Read full files** when snippets are promising
5. **Combine searches** for complex queries

## Limitations

- Search is semantic (meaning-based), not exact match
- Results depend on embedding quality
- Very recent additions may not be indexed yet
- File paths use relative format from memory root

## Example: Research Workflow

```typescript
// 1. Search for relevant info
const searchResults = await memory_search({
  query: "microservices communication patterns",
  maxResults: 10,
});

// 2. Read most relevant documents
for (const result of searchResults.slice(0, 3)) {
  await memory_get({ relPath: result.path });
}

// 3. Search for specific implementation
await memory_search({
  query: "message queue vs REST API",
  maxResults: 5,
});
```

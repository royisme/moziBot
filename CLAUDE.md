Default to using Bun instead of Node.js for runtime execution.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `pnpm install` instead of `npm install` or `yarn install` or `bun install`
- Use `pnpm run <script>` instead of `npm run <script>` or `yarn run <script>` or `bun run <script>`
- Use `pnpm dlx <package> <command>` instead of `npx <package> <command>` or `bunx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `pnpm run test` to run repo tests. Only use `bun test` for Bun-specific test files.

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## MCP 工具选择规则

以下规则说明在何种需求/情况下优先使用哪个 MCP 工具。

### serena（代码符号级操作）

- **IF** 需要查找/分析/修改代码中的类、函数、方法 → 优先用 `find_symbol`, `get_symbols_overview`, `replace_symbol_body`
- **IF** 需要搜索代码模式或引用关系 → 用 `search_for_pattern`, `find_referencing_symbols`
- **IF** 需要精细行级替换 → 用 `replace_content`（正则替换）
- **ELSE**（简单单文件读取）→ 用标准 Read/Glob/Grep

### context-mode（大输出压缩）

- **IF** 命令输出可能超过 50 行（测试结果、构建日志、grep 结果、git log）→ 优先用 `execute` 或 `batch_execute`
- **IF** 需要搜索已索引内容 → 用 `search`
- **ELSE**（输出确定很短）→ 直接用 Bash

### context7（第三方库文档）

- **IF** 需要查询第三方库 API / 最新用法 / 示例代码 → 先 `resolve-library-id`，再 `query-docs`
- **ELSE** → 直接读 node_modules 类型定义或本地文档

### playwright（浏览器自动化）

- **IF** 需要访问网页、填表单、截图、测试 Web UI、抓取动态内容 → 用 playwright 系列工具
- **ELSE**（只读静态页面内容）→ 用 WebFetch

### pencil（UI 设计文件）

- **IF** 操作 .pen 设计文件（查看/修改节点、布局、变量）→ 只能用 pencil 工具，**严禁用 Read/Grep 读取 .pen**
- **ELSE** → 不使用

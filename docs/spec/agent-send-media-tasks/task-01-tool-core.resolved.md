# Task 01: Tool Core — `createSendMediaTool`

## 依赖
无依赖

## 目标
新建 `src/runtime/tools/send-media.ts`，实现完整的 `createSendMediaTool(deps)` 工厂函数，并新建对应单元测试文件覆盖 6 个测试场景。

## 涉及文件
- `src/runtime/tools/send-media.ts` — 新建，完整工具实现
- `src/runtime/tools/send-media.test.ts` — 新建，单元测试

## 实现要点

**`send-media.ts`** — 完整代码在 spec `agent-send-media-tool.md` Section 5，直接照搬，不做修改：
- `SendMediaToolDeps` 接口：`getChannel`, `getPeerId`, `workspaceDir`, `extraLocalRoots?`
- `resolveLocalRoots(workspaceDir, extra?)` — 组合 workspace + `~/Downloads/Desktop/Pictures/Movies/Music` + extra，全部 `path.resolve`
- `isPathAllowed(filePath, localRoots)` — 检查绝对路径且前缀命中 root（用 `path.sep`，不用硬编码 `/`）
- `inferMediaType(filePath, hint?)` — hint 优先；扩展名映射：jpg/png/gif/webp → `photo`，mp4/mov/avi/mkv → `video`，mp3/ogg/wav/m4a/flac → `audio`，其余 → `document`
- `execute()` 中错误只 return 工具错误内容，不 throw；`Bun.file(path).arrayBuffer()` 读文件，转 `Buffer.from(ab)`
- `channel.send(peerId, { media })` 直接调用，不走 `dispatchReply`

**`send-media.test.ts`** — 使用 vitest（`import { describe, it, expect, vi } from "vitest"`）：

```ts
// 测试组结构：
describe("send_media tool", () => {
  // 1. 路径白名单
  it("allows path within workspaceDir")
  it("denies /etc/passwd")
  it("denies relative path")
  it("denies path traversal ../../escape")

  // 2. 文件不存在
  it("returns file_not_found when file does not exist")

  // 3. channel 无媒体能力
  it("returns channel_no_media_support when caps.media === false")

  // 4. 正常发送
  it("calls channel.send with correct buffer and inferred type")
  it("infers .jpg → photo, .mp4 → video, .txt → document")

  // 5. mediaType hint 优先
  it("respects mediaType hint over file extension")

  // 6. channel.send 抛异常
  it("returns send_failed on channel.send throw, does not rethrow")
})
```

Mock 策略：
- `Bun.file` 通过 `vi.stubGlobal("Bun", { file: vi.fn().mockReturnValue({ exists: ..., arrayBuffer: ... }) })` mock
- `channel.send` 用 `vi.fn().mockResolvedValue("msg-123")`
- `channel.getCapabilities()` 返回 `{ media: true/false, ... }`

## 验收标准
- [ ] `pnpm run check` 通过（无 TS 错误）
- [ ] `pnpm run test src/runtime/tools/send-media.test.ts` — 所有测试通过
- [ ] `isPathAllowed` 对 `path.sep` 不硬编码为 `/`（Windows 兼容）
- [ ] 错误分支均返回 `{ content: [{ type: "text", text: "..." }], details: { error: "..." } }` 形态，不 throw

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelCapabilities, MediaAttachment } from "../adapters/channels/types.js";
import type { ChannelDispatcherBridge } from "../host/message-handler/contract.js";
import {
  createSendMediaTool,
  inferMediaType,
  isPathAllowed,
  resolveLocalRoots,
} from "./send-media.js";

vi.mock("node:fs/promises", () => ({
  stat: vi.fn().mockResolvedValue({}),
  readFile: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
}));

function createChannel(
  media: boolean,
  sendImpl?: (peerId: string, message: { media?: MediaAttachment[] }) => Promise<string>,
): ChannelDispatcherBridge {
  const capabilities: ChannelCapabilities = {
    media,
    polls: false,
    reactions: false,
    threads: false,
    editMessage: false,
    deleteMessage: false,
    implicitCurrentTarget: true,
    supportedActions: media ? ["send_text", "send_media", "reply"] : ["send_text", "reply"],
  };

  return {
    id: "test-channel",
    getCapabilities: () => capabilities,
    send: vi.fn(sendImpl ?? (async () => "msg-123")),
  };
}

describe("send_media tool", () => {
  const workspaceDir = "/workspace/project";

  beforeEach(async () => {
    const fsMock = await import("node:fs/promises");
    vi.mocked(fsMock.stat).mockResolvedValue({} as Awaited<ReturnType<typeof fsMock.stat>>);
    vi.mocked(fsMock.readFile).mockResolvedValue(
      Buffer.from([1, 2, 3]) as Awaited<ReturnType<typeof fsMock.readFile>>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows path within workspaceDir", () => {
    const roots = resolveLocalRoots(workspaceDir);
    expect(isPathAllowed(path.join(workspaceDir, "images", "a.jpg"), roots)).toBe(true);
  });

  it("denies /etc/passwd", () => {
    const roots = resolveLocalRoots(workspaceDir);
    expect(isPathAllowed("/etc/passwd", roots)).toBe(false);
  });

  it("denies relative path", () => {
    const roots = resolveLocalRoots(workspaceDir);
    expect(isPathAllowed("images/a.jpg", roots)).toBe(false);
  });

  it("denies path traversal ../../escape", () => {
    const roots = [workspaceDir];
    expect(isPathAllowed(path.resolve(workspaceDir, "../../escape.txt"), roots)).toBe(false);
  });

  it("returns file_not_found when file does not exist", async () => {
    const fsMock = await import("node:fs/promises");
    vi.mocked(fsMock.stat).mockRejectedValue(new Error("ENOENT"));
    const channel = createChannel(true);
    const tool = createSendMediaTool({
      workspaceDir,
      getChannel: () => channel,
      getPeerId: () => "peer-1",
    });

    const result = await tool.execute("call-1", { filePath: "/workspace/project/missing.jpg" });

    expect(result.details).toEqual({ error: "file_not_found" });
    expect(result.content[0]?.type).toBe("text");
    expect((result.content[0] as { type: "text"; text: string })?.text).toContain("File not found");
  });

  it("returns channel_no_media_support when caps.media === false", async () => {
    const channel = createChannel(false);
    const tool = createSendMediaTool({
      workspaceDir,
      getChannel: () => channel,
      getPeerId: () => "peer-1",
    });

    const result = await tool.execute("call-1", { filePath: "/workspace/project/file.jpg" });

    expect(result.details).toEqual({ error: "channel_no_media_support" });
    expect((result.content[0] as { type: "text"; text: string })?.text).toContain(
      "does not support media",
    );
  });

  it("calls channel.send with correct buffer and inferred type", async () => {
    const channel = createChannel(true);
    const tool = createSendMediaTool({
      workspaceDir,
      getChannel: () => channel,
      getPeerId: () => "peer-1",
    });

    const result = await tool.execute("call-1", { filePath: "/workspace/project/photo.jpg" });

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith("peer-1", {
      media: [
        expect.objectContaining({
          type: "photo",
          path: "/workspace/project/photo.jpg",
          filename: "photo.jpg",
          byteSize: 3,
          buffer: Buffer.from([1, 2, 3]),
        }),
      ],
    });
    expect(result.details).toMatchObject({ ok: true, messageId: "msg-123", mediaType: "photo" });
  });

  it("infers .jpg → photo, .mp4 → video, .txt → document", () => {
    expect(inferMediaType("/tmp/a.jpg")).toBe("photo");
    expect(inferMediaType("/tmp/a.mp4")).toBe("video");
    expect(inferMediaType("/tmp/a.txt")).toBe("document");
  });

  it("respects mediaType hint over file extension", async () => {
    const channel = createChannel(true);
    const tool = createSendMediaTool({
      workspaceDir,
      getChannel: () => channel,
      getPeerId: () => "peer-1",
    });

    await tool.execute("call-1", {
      filePath: "/workspace/project/photo.jpg",
      mediaType: "document",
    });

    expect(channel.send).toHaveBeenCalledWith("peer-1", {
      media: [expect.objectContaining({ type: "document" })],
    });
  });

  it("returns send_failed on channel.send throw, does not rethrow", async () => {
    const channel = createChannel(true, async () => {
      throw new Error("boom");
    });
    const tool = createSendMediaTool({
      workspaceDir,
      getChannel: () => channel,
      getPeerId: () => "peer-1",
    });

    const result = await tool.execute("call-1", { filePath: "/workspace/project/photo.jpg" });

    expect(result.details).toEqual({ error: "send_failed" });
    expect((result.content[0] as { type: "text"; text: string })?.text).toContain("boom");
  });
});

import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { MediaAttachment } from "../adapters/channels/types.js";
import type { ChannelDispatcherBridge } from "../host/message-handler/contract.js";

export interface SendMediaToolDeps {
  getChannel: () => ChannelDispatcherBridge | undefined;
  getPeerId: () => string | undefined;
  workspaceDir: string;
  extraLocalRoots?: string[];
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type SendMediaArgs = {
  filePath: string;
  mediaType?: MediaAttachment["type"] | undefined;
};

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".ogg", ".wav", ".m4a", ".flac"]);

export function createSendMediaTool(deps: SendMediaToolDeps): AgentTool {
  return {
    name: "send_media",
    label: "Send Media",
    description: "Send a local media file from allowed local roots to the current conversation.",
    parameters: Type.Object({
      filePath: Type.String({ minLength: 1 }),
      mediaType: Type.Optional(Type.String({ minLength: 1 })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = normalizeArgs(rawArgs);
      if (!args) {
        return toolError(
          "invalid_args",
          "Invalid tool arguments. Expected filePath and optional mediaType.",
        );
      }

      const channel = deps.getChannel();
      const peerId = deps.getPeerId();
      if (!channel || !peerId) {
        return toolError("missing_channel_context", "Current channel context is unavailable.");
      }

      const caps = channel.getCapabilities();
      if (!caps.media) {
        return toolError(
          "channel_no_media_support",
          "Current channel does not support media sending.",
        );
      }

      const localRoots = resolveLocalRoots(deps.workspaceDir, deps.extraLocalRoots);
      const resolvedPath = path.resolve(args.filePath);
      if (!isPathAllowed(resolvedPath, localRoots)) {
        return toolError(
          "path_not_allowed",
          "filePath must be an absolute path inside an allowed local root.",
        );
      }

      const exists = await stat(resolvedPath)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        return toolError("file_not_found", `File not found: ${resolvedPath}`);
      }

      try {
        const buffer = await readFile(resolvedPath);
        const media: MediaAttachment = {
          type: inferMediaType(resolvedPath, args.mediaType),
          path: resolvedPath,
          buffer,
          filename: path.basename(resolvedPath),
          byteSize: buffer.byteLength,
        };

        const messageId = await channel.send(peerId, { media: [media] });
        return {
          content: [{ type: "text", text: `Sent media: ${media.filename}` }],
          details: {
            ok: true,
            messageId,
            mediaType: media.type,
            filePath: resolvedPath,
          },
        } satisfies ToolResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError("send_failed", `Failed to send media: ${message}`);
      }
    },
  };
}

export function resolveLocalRoots(workspaceDir: string, extra: string[] = []): string[] {
  const homeDir = os.homedir();
  return [
    workspaceDir,
    path.join(homeDir, "Downloads"),
    path.join(homeDir, "Desktop"),
    path.join(homeDir, "Pictures"),
    path.join(homeDir, "Movies"),
    path.join(homeDir, "Music"),
    ...extra,
  ].map((root) => path.resolve(root));
}

export function isPathAllowed(filePath: string, localRoots: string[]): boolean {
  if (!path.isAbsolute(filePath)) {
    return false;
  }

  const resolvedFilePath = path.resolve(filePath);
  return localRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return (
      resolvedFilePath === resolvedRoot || resolvedFilePath.startsWith(`${resolvedRoot}${path.sep}`)
    );
  });
}

export function inferMediaType(filePath: string, hint?: string): MediaAttachment["type"] {
  if (hint) {
    return normalizeMediaTypeHint(hint);
  }

  const extension = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "photo";
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }
  return "document";
}

function normalizeArgs(rawArgs: unknown): SendMediaArgs | undefined {
  if (!rawArgs || typeof rawArgs !== "object") {
    return undefined;
  }

  const candidate = rawArgs as Record<string, unknown>;
  if (typeof candidate.filePath !== "string" || candidate.filePath.length === 0) {
    return undefined;
  }

  return {
    filePath: candidate.filePath,
    mediaType:
      typeof candidate.mediaType === "string"
        ? normalizeMediaTypeHint(candidate.mediaType)
        : undefined,
  };
}

function normalizeMediaTypeHint(hint: string): MediaAttachment["type"] {
  switch (hint) {
    case "photo":
    case "video":
    case "audio":
    case "document":
    case "voice":
    case "animation":
    case "video_note":
    case "gif":
      return hint;
    default:
      return "document";
  }
}

function toolError(error: string, text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: { error },
  };
}

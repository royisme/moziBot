import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { DeliveryPlan } from "./capabilities";
import { multimodal } from "../storage/db";

export const MAX_PROVIDER_INLINE_MEDIA_BYTES = 10 * 1024 * 1024;

type MediaResolutionResult = {
  images: ImageContent[];
  degradationNotices: string[];
};

type MediaResolutionOptions = {
  maxInlineBytes?: number;
  strict?: boolean;
  localFileAllowlist?: string[];
  remote?: {
    timeoutMs?: number;
    maxBytes?: number;
    allowedHosts?: string[];
  };
};

function normalizeMimeType(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "application/octet-stream";
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)}KB`;
  }
  return `${value}B`;
}

function buildNotice(mediaId: string, reason: string): string {
  return `- media ${mediaId}: ${reason}`;
}

function isPathWithin(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(parentDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertAllowedLocalFile(filePath: string, allowlist?: string[]): Promise<void> {
  if (!allowlist || allowlist.length === 0) {
    return;
  }

  const realFilePath = await realpath(filePath);
  for (const base of allowlist) {
    const basePath = path.resolve(base);
    const realBasePath = await realpath(basePath).catch(() => null);
    if (realBasePath && isPathWithin(realBasePath, realFilePath)) {
      return;
    }
  }

  throw new Error("local file path is not in allowlist");
}

async function readFileBlobAsImage(params: {
  blobUri: string;
  mimeType: string;
  maxBytes: number;
  localFileAllowlist?: string[];
}): Promise<ImageContent | null> {
  const filePath = fileURLToPath(params.blobUri);
  await assertAllowedLocalFile(filePath, params.localFileAllowlist);
  const info = await stat(filePath);
  if (info.size > params.maxBytes) {
    return null;
  }
  const data = await readFile(filePath);
  if (data.byteLength > params.maxBytes) {
    return null;
  }
  return {
    type: "image",
    data: data.toString("base64"),
    mimeType: params.mimeType,
  };
}

function isRemoteHostAllowed(blobUri: string, allowedHosts?: string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) {
    return true;
  }
  const host = new URL(blobUri).hostname.toLowerCase();
  return allowedHosts.some((entry) => host === entry.toLowerCase());
}

async function fetchRemoteBlobAsImage(params: {
  blobUri: string;
  mimeType: string;
  maxBytes: number;
  timeoutMs?: number;
  allowedHosts?: string[];
}): Promise<ImageContent> {
  if (!isRemoteHostAllowed(params.blobUri, params.allowedHosts)) {
    throw new Error("remote host is not allowed by policy");
  }

  const timeoutMs = params.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(params.blobUri, { signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
  if (!response.ok) {
    throw new Error(`fetch failed with status ${response.status}`);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > params.maxBytes) {
    throw new Error(`remote media too large (${formatBytes(declaredLength)})`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > params.maxBytes) {
        throw new Error(`remote media too large (${formatBytes(total)})`);
      }
      chunks.push(buffer);
    }
  }

  const data = Buffer.concat(chunks);
  return {
    type: "image",
    data: data.toString("base64"),
    mimeType: params.mimeType,
  };
}

function readDataUriAsImage(params: {
  blobUri: string;
  mimeType: string;
  maxBytes: number;
}): ImageContent {
  const match = params.blobUri.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i);
  if (!match) {
    throw new Error("invalid data URI format");
  }
  const mimeType = normalizeMimeType(match[1] ?? params.mimeType);
  const dataPart = match[2] ?? "";
  const data = Buffer.from(dataPart, "base64");
  if (data.byteLength > params.maxBytes) {
    throw new Error(`data URI too large (${formatBytes(data.byteLength)})`);
  }
  return {
    type: "image",
    data: data.toString("base64"),
    mimeType,
  };
}

export async function resolveProviderInputMediaAsImages(
  plan: DeliveryPlan | null | undefined,
  options?: MediaResolutionOptions,
): Promise<MediaResolutionResult> {
  const maxBytes = options?.maxInlineBytes ?? MAX_PROVIDER_INLINE_MEDIA_BYTES;
  const strict = options?.strict === true;
  const remoteMaxBytes = options?.remote?.maxBytes ?? maxBytes;
  const images: ImageContent[] = [];
  const degradationNotices: string[] = [];
  const providerInput = plan?.providerInput ?? [];

  let mediaPartCount = 0;

  for (const part of providerInput) {
    if (part.modality === "text") {
      continue;
    }

    mediaPartCount += 1;
    const mediaId = part.media.mediaId;
    const asset = multimodal.getMediaAssetById(mediaId);
    if (!asset?.blob_uri) {
      degradationNotices.push(buildNotice(mediaId, "missing blob_uri in multimodal media store"));
      continue;
    }

    const blobUri = asset.blob_uri.trim();
    const mimeType = normalizeMimeType(part.media.mimeType || asset.mime_type);

    try {
      if (blobUri.startsWith("file://")) {
        const image = await readFileBlobAsImage({
          blobUri,
          mimeType,
          maxBytes,
          localFileAllowlist: options?.localFileAllowlist,
        });
        if (!image) {
          degradationNotices.push(
            buildNotice(mediaId, `file too large for inline transport (> ${formatBytes(maxBytes)})`),
          );
          continue;
        }
        images.push(image);
        continue;
      }

      if (blobUri.startsWith("http://") || blobUri.startsWith("https://")) {
        const image = await fetchRemoteBlobAsImage({
          blobUri,
          mimeType,
          maxBytes: remoteMaxBytes,
          timeoutMs: options?.remote?.timeoutMs,
          allowedHosts: options?.remote?.allowedHosts,
        });
        images.push(image);
        continue;
      }

      if (blobUri.startsWith("data:")) {
        const image = readDataUriAsImage({
          blobUri,
          mimeType,
          maxBytes,
        });
        images.push(image);
        continue;
      }

      degradationNotices.push(
        buildNotice(mediaId, `unsupported blob_uri scheme for provider input: ${blobUri}`),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      degradationNotices.push(buildNotice(mediaId, message));
    }
  }

  if (strict && mediaPartCount > 0 && images.length !== mediaPartCount) {
    throw new Error(
      `strict media resolution failed: resolved ${images.length}/${mediaPartCount} media item(s); ${degradationNotices.join("; ")}`,
    );
  }

  return { images, degradationNotices };
}

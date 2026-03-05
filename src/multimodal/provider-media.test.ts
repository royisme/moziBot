import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import { convertMessages } from "@mariozechner/pi-ai/dist/providers/openai-completions.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb, multimodal } from "../storage/db";
import type { DeliveryPlan } from "./capabilities";
import { resolveProviderInputMediaAsImages } from "./provider-media";

const TEST_DB = "data/multimodal-provider-media.test.db";
const TMP_DIR = "data/tmp-multimodal-provider-media";

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${TEST_DB}${suffix}`;
    if (existsSync(candidate)) {
      unlinkSync(candidate);
    }
  }
}

function buildPlan(mediaId: string): DeliveryPlan {
  return {
    acceptedInput: [],
    providerInput: [
      {
        id: "p1",
        role: "user",
        index: 0,
        modality: "text",
        text: "describe attached media",
        format: "plain",
      },
      {
        id: "p2",
        role: "user",
        index: 1,
        modality: "image",
        media: {
          mediaId,
          mimeType: "image/png",
          byteSize: 4,
          sha256: "sha-1",
        },
      },
    ],
    outputModalities: ["text"],
    transforms: [],
    fallbackUsed: false,
  };
}

function upsertMediaAsset(args: { id: string; blobUri: string; byteSize: number }) {
  multimodal.upsertMediaAsset({
    id: args.id,
    tenant_id: "mozi",
    sha256: `sha-${args.id}`,
    mime_type: "image/png",
    byte_size: args.byteSize,
    duration_ms: null,
    width: null,
    height: null,
    filename: "test.png",
    blob_uri: args.blobUri,
    scan_status: "clean",
    created_at: new Date().toISOString(),
  });
}

const OPENAI_COMPLETIONS_COMPAT: Required<OpenAICompletionsCompat> = {
  supportsStore: true,
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresMistralToolIds: false,
  thinkingFormat: "openai",
  openRouterRouting: {},
  vercelGatewayRouting: {},
  supportsStrictMode: true,
};

const TEST_MODEL: Model<"openai-completions"> = {
  id: "vision-model",
  name: "vision-model",
  api: "openai-completions",
  provider: "quotio",
  baseUrl: "https://api.quotio.ai/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

describe("resolveProviderInputMediaAsImages", () => {
  beforeEach(() => {
    closeDb();
    cleanup();
    mkdirSync(TMP_DIR, { recursive: true });
    initDb(TEST_DB, 1);
  });

  afterEach(() => {
    closeDb();
    cleanup();
  });

  it("resolves file:// media to base64 image content and converts to image_url payload", async () => {
    const localPath = path.resolve(TMP_DIR, "small-image.bin");
    const bytes = Buffer.from([1, 2, 3, 4]);
    writeFileSync(localPath, bytes);

    upsertMediaAsset({
      id: "media-1",
      blobUri: `file://${localPath}`,
      byteSize: bytes.length,
    });

    const result = await resolveProviderInputMediaAsImages(buildPlan("media-1"));

    expect(result.degradationNotices).toEqual([]);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: bytes.toString("base64"),
    });

    const messages = convertMessages(
      TEST_MODEL,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe attached media" },
              ...result.images,
            ],
            timestamp: Date.now(),
          },
        ],
      },
      OPENAI_COMPLETIONS_COMPAT,
    );

    expect(messages).toHaveLength(1);
    const content = messages[0]?.role === "user" && Array.isArray(messages[0].content)
      ? messages[0].content
      : [];
    const imagePart = content.find((part) => part.type === "image_url");
    expect(imagePart).toBeDefined();
    expect(imagePart && "image_url" in imagePart ? imagePart.image_url.url : "").toContain(
      "data:image/png;base64,",
    );
  });

  it("degrades oversized file:// media to text notice", async () => {
    const localPath = path.resolve(TMP_DIR, "large-image.bin");
    const bytes = Buffer.alloc(64, 7);
    writeFileSync(localPath, bytes);

    upsertMediaAsset({
      id: "media-2",
      blobUri: `file://${localPath}`,
      byteSize: bytes.length,
    });

    const result = await resolveProviderInputMediaAsImages(buildPlan("media-2"), {
      maxInlineBytes: 16,
    });

    expect(result.images).toEqual([]);
    expect(result.degradationNotices.some((item) => item.includes("file too large"))).toBe(true);
  });

  it("supports data URI media", async () => {
    upsertMediaAsset({
      id: "media-data",
      blobUri: "data:image/png;base64,AQIDBA==",
      byteSize: 4,
    });

    const result = await resolveProviderInputMediaAsImages(buildPlan("media-data"));

    expect(result.degradationNotices).toEqual([]);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: "AQIDBA==",
    });
  });

  it("throws in strict mode when any media cannot be resolved", async () => {
    upsertMediaAsset({
      id: "media-strict-missing",
      blobUri: "s3://bucket/object",
      byteSize: 4,
    });

    await expect(
      resolveProviderInputMediaAsImages(buildPlan("media-strict-missing"), { strict: true }),
    ).rejects.toThrow("strict media resolution failed");
  });

  it("keeps behavior unchanged when no media parts exist", async () => {
    const result = await resolveProviderInputMediaAsImages({
      acceptedInput: [],
      providerInput: [
        {
          id: "p1",
          role: "user",
          index: 0,
          modality: "text",
          text: "hello",
          format: "plain",
        },
      ],
      outputModalities: ["text"],
      transforms: [],
      fallbackUsed: false,
    });

    expect(result.images).toEqual([]);
    expect(result.degradationNotices).toEqual([]);
  });
});

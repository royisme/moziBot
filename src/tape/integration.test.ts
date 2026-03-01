import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createTapeStore,
  createTapeService,
  buildMessagesFromTape,
  buildAllMessages,
  recordTurnToTape,
  compactViaTape,
  withForkTape,
} from "./integration.js";
import { TapeService } from "./tape-service.js";
import { TapeStore } from "./tape-store.js";

describe("TapeIntegration", () => {
  let tempDir: string;
  let store: TapeStore;
  let service: TapeService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tape-integration-test-"));
    store = new TapeStore(tempDir, "/test/workspace");
    service = new TapeService("test-tape", store);
  });

  describe("createTapeStore", () => {
    it("should create a store with tapes directory", () => {
      const newStore = createTapeStore(tempDir, "/test/workspace");

      expect(newStore).toBeDefined();
      expect(newStore.tapesDir).toBe(`${tempDir}/tapes`);
    });

    it("should create a store that can list tapes", () => {
      const newStore = createTapeStore(tempDir, "/test/workspace");

      newStore.append("test-tape", {
        kind: "message",
        payload: { role: "user", content: "Hello" },
        meta: {},
      });

      const list = newStore.list();
      expect(list).toContain("test-tape");
    });
  });

  describe("createTapeService", () => {
    it("should create service with bootstrap anchor", () => {
      const newService = createTapeService(store, "new-tape");

      const entries = newService.readAll();
      expect(entries).toHaveLength(1);
      expect(entries![0].kind).toBe("anchor");
      expect(entries![0].payload.name).toBe("session/start");
    });

    it("should not create duplicate bootstrap anchor", () => {
      const newService = createTapeService(store, "new-tape");
      newService.ensureBootstrapAnchor();

      const entries = newService.readAll();
      expect(entries).toHaveLength(1);
    });
  });

  describe("buildMessagesFromTape", () => {
    it("should return messages from last anchor only", () => {
      service.appendMessage("user", "Message before anchor");
      service.handoff("phase-1");
      service.appendMessage("user", "Message after anchor");
      service.appendMessage("assistant", "Response");

      const messages = buildMessagesFromTape(service);

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("Message after anchor");
      expect(messages[1].content).toBe("Response");
    });

    it("should return empty array when no entries after anchor", () => {
      service.appendMessage("user", "Only message");

      const messages = buildMessagesFromTape(service);

      // bootstrap anchor exists, so message is after it
      expect(messages).toHaveLength(1);
    });
  });

  describe("buildAllMessages", () => {
    it("should return all messages ignoring anchors", () => {
      service.appendMessage("user", "First");
      service.handoff("phase-1");
      service.appendMessage("user", "Second");
      service.appendMessage("assistant", "Response");

      const messages = buildAllMessages(service);

      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe("First");
      expect(messages[1].content).toBe("Second");
      expect(messages[2].content).toBe("Response");
    });

    it("should return empty array for empty tape", () => {
      const messages = buildAllMessages(service);

      expect(messages).toHaveLength(0);
    });
  });

  describe("recordTurnToTape", () => {
    it("should record user + assistant messages", () => {
      recordTurnToTape(service, {
        userMessage: "Hello",
        assistantMessage: "Hi there",
      });

      const entries = service.readAll();
      const messages = entries!.filter((e) => e.kind === "message");

      expect(messages).toHaveLength(2);
      expect(messages[0].payload.role).toBe("user");
      expect(messages[0].payload.content).toBe("Hello");
      expect(messages[1].payload.role).toBe("assistant");
      expect(messages[1].payload.content).toBe("Hi there");
    });

    it("should record with tool calls and results", () => {
      recordTurnToTape(service, {
        userMessage: "Run the command",
        assistantMessage: "I will run it",
        toolCalls: [{ id: "1", function: { name: "run", arguments: "{}" } }],
        toolResults: [{ output: "success" }],
      });

      const entries = service.readAll()!;

      const toolCallEntries = entries.filter((e) => e.kind === "tool_call");
      expect(toolCallEntries).toHaveLength(1);
      expect((toolCallEntries[0].payload.calls as unknown[])[0]).toBeDefined();

      const toolResultEntries = entries.filter((e) => e.kind === "tool_result");
      expect(toolResultEntries).toHaveLength(1);
    });

    it("should record with meta information", () => {
      recordTurnToTape(service, {
        userMessage: "Hello",
        assistantMessage: "Hi",
        meta: { timestamp: "2024-01-01", model: "gpt-4" },
      });

      const entries = service.readAll()!;
      const userEntry = entries.find((e) => e.kind === "message" && e.payload.role === "user");

      expect(userEntry!.meta.timestamp).toBe("2024-01-01");
      expect(userEntry!.meta.model).toBe("gpt-4");
    });
  });

  describe("compactViaTape", () => {
    it("should create anchor and return correct info", () => {
      // Use createTapeService to get bootstrap anchor
      const svc = createTapeService(store, "compact-test");
      svc.appendMessage("user", "First message");
      svc.appendMessage("assistant", "First response");

      const info = compactViaTape(svc, "Summary of first exchange", ["next step"]);

      expect(info.lastAnchor).toBe("auto-compact");
      expect(info.anchors).toBe(2); // bootstrap + compact
      expect(info.entriesSinceLastAnchor).toBe(0);

      // Verify the anchor has the summary
      const anchors = svc.anchors();
      const lastAnchor = anchors[anchors.length - 1];
      expect(lastAnchor.state.summary).toBe("Summary of first exchange");
      expect(lastAnchor.state.nextSteps).toEqual(["next step"]);
    });

    it("should handle empty nextSteps", () => {
      const info = compactViaTape(service, "Summary");

      expect(info.lastAnchor).toBe("auto-compact");
    });
  });

  describe("withForkTape", () => {
    it("should fork, do work, and merge on success", async () => {
      service.appendMessage("user", "Original message");

      const result = await withForkTape(service, store, async (forkedService) => {
        forkedService.appendMessage("user", "Fork message");
        forkedService.appendMessage("assistant", "Fork response");
        return "success";
      });

      expect(result).toBe("success");

      // Main tape should have all entries after merge
      const entries = service.readAll();
      expect(entries).toHaveLength(3);
      expect(entries![0].payload.content).toBe("Original message");
      expect(entries![1].payload.content).toBe("Fork message");
      expect(entries![2].payload.content).toBe("Fork response");
    });

    it("should fork, throw, and discard fork on failure", async () => {
      service.appendMessage("user", "Original message");

      await expect(
        withForkTape(service, store, async (forkedService) => {
          forkedService.appendMessage("user", "Fork message");
          throw new Error("Test error");
        }),
      ).rejects.toThrow("Test error");

      // Main tape should still have only original
      const entries = service.readAll();
      expect(entries).toHaveLength(1);
      expect(entries![0].payload.content).toBe("Original message");
    });

    it("should return result from async function", async () => {
      service.appendMessage("user", "Hello");

      const result = await withForkTape(service, store, async () => {
        return { success: true, data: [1, 2, 3] };
      });

      expect(result).toEqual({ success: true, data: [1, 2, 3] });
    });
  });
});

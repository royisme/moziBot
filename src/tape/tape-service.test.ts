import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { TapeService } from "./tape-service.js";
import { TapeStore } from "./tape-store.js";

describe("TapeService", () => {
  let tempDir: string;
  let store: TapeStore;
  let service: TapeService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tape-service-test-"));
    store = new TapeStore(tempDir, "/test/workspace");
    service = new TapeService("my-tape", store);
  });

  describe("appendMessage", () => {
    it("should append message and return entry with id", () => {
      const entry = service.appendMessage("user", "Hello world");

      expect(entry.id).toBe(1);
      expect(entry.kind).toBe("message");
      expect(entry.payload.role).toBe("user");
      expect(entry.payload.content).toBe("Hello world");
    });

    it("should persist and read back all entries", () => {
      service.appendMessage("user", "Hello");
      service.appendMessage("assistant", "Hi there");

      const entries = service.readAll();
      expect(entries).toHaveLength(2);
      expect(entries![0].payload.content).toBe("Hello");
      expect(entries![1].payload.content).toBe("Hi there");
    });
  });

  describe("handoff", () => {
    it("should create anchor entry", () => {
      const entry = service.handoff("phase-1", { owner: "agent" });

      expect(entry.kind).toBe("anchor");
      expect(entry.payload.name).toBe("phase-1");
      expect(entry.payload.state).toEqual({ owner: "agent" });
    });
  });

  describe("ensureBootstrapAnchor", () => {
    it("should create anchor only once", () => {
      service.ensureBootstrapAnchor();
      service.appendMessage("user", "Hello");
      service.ensureBootstrapAnchor();

      const entries = service.readAll();
      const anchors = entries!.filter((e) => e.kind === "anchor");
      expect(anchors).toHaveLength(1);
      expect(anchors[0].payload.name).toBe("session/start");
    });
  });

  describe("info", () => {
    it("should return correct counts", () => {
      service.appendMessage("user", "Hello");
      service.appendMessage("assistant", "Hi");
      service.handoff("phase-1");
      service.appendMessage("user", "How are you?");

      const info = service.info();

      expect(info.name).toBe("my-tape");
      expect(info.entries).toBe(4);
      expect(info.anchors).toBe(1);
      expect(info.lastAnchor).toBe("phase-1");
      expect(info.entriesSinceLastAnchor).toBe(1); // only "How are you?"
    });

    it("should handle empty tape", () => {
      const info = service.info();

      expect(info.entries).toBe(0);
      expect(info.anchors).toBe(0);
      expect(info.lastAnchor).toBeNull();
      expect(info.entriesSinceLastAnchor).toBe(0);
    });
  });

  describe("anchors", () => {
    it("should return anchor summaries", () => {
      service.handoff("phase-1", { owner: "agent" });
      service.appendMessage("user", "Hello");
      service.handoff("phase-2", { owner: "human", summary: "test summary" });

      const anchorSummaries = service.anchors();

      expect(anchorSummaries).toHaveLength(2);
      expect(anchorSummaries[0].name).toBe("phase-1");
      expect(anchorSummaries[0].state).toEqual({ owner: "agent" });
      expect(anchorSummaries[1].name).toBe("phase-2");
      expect(anchorSummaries[1].state).toEqual({ owner: "human", summary: "test summary" });
    });

    it("should respect limit", () => {
      service.handoff("phase-1");
      service.handoff("phase-2");
      service.handoff("phase-3");

      const anchors = service.anchors(2);

      expect(anchors).toHaveLength(2);
      expect(anchors[0].name).toBe("phase-2");
      expect(anchors[1].name).toBe("phase-3");
    });
  });

  describe("fromLastAnchor", () => {
    it("should return only entries after last anchor", () => {
      service.appendMessage("user", "Hello");
      service.handoff("phase-1");
      service.appendMessage("user", "After anchor 1");
      service.appendMessage("assistant", "Response");
      service.handoff("phase-2");
      service.appendMessage("user", "After anchor 2");

      const entries = service.fromLastAnchor();

      expect(entries).toHaveLength(1);
      expect(entries[0].payload.content).toBe("After anchor 2");
    });

    it("should filter by kinds", () => {
      service.handoff("phase-1");
      service.appendMessage("user", "Hello");
      service.appendToolCall([{ id: "1", function: { name: "test" } }]);
      service.appendToolResult(["result"]);

      const entries = service.fromLastAnchor(["message"]);

      expect(entries).toHaveLength(1);
      expect(entries[0].kind).toBe("message");
    });
  });

  describe("betweenAnchors", () => {
    it("should return entries between named anchors", () => {
      service.appendMessage("user", "Before");
      service.handoff("start");
      service.appendMessage("user", "Middle 1");
      service.appendMessage("assistant", "Middle 2");
      service.handoff("end");
      service.appendMessage("user", "After");

      const entries = service.betweenAnchors("start", "end");

      expect(entries).toHaveLength(2);
      expect(entries[0].payload.content).toBe("Middle 1");
      expect(entries[1].payload.content).toBe("Middle 2");
    });

    it("should return empty if anchors not found", () => {
      service.appendMessage("user", "Hello");

      const entries = service.betweenAnchors("nonexistent", "also-nonexistent");

      expect(entries).toHaveLength(0);
    });
  });

  describe("afterAnchor", () => {
    it("should return entries after named anchor", () => {
      service.handoff("phase-1");
      service.appendMessage("user", "After");
      service.appendMessage("assistant", "Response");

      const entries = service.afterAnchor("phase-1");

      expect(entries).toHaveLength(2);
    });

    it("should return empty if anchor not found", () => {
      service.appendMessage("user", "Hello");

      const entries = service.afterAnchor("nonexistent");

      expect(entries).toHaveLength(0);
    });
  });

  describe("search", () => {
    it("should find matching entries", () => {
      service.appendMessage("user", "Hello world");
      service.appendMessage("assistant", "Hi there");
      service.appendMessage("user", "Search for this keyword");

      const results = service.search("keyword");

      expect(results).toHaveLength(1);
      expect(results[0].payload.content).toBe("Search for this keyword");
    });

    it("should return results in reverse order", () => {
      service.appendMessage("user", "test 1");
      service.appendMessage("user", "test 2");
      service.appendMessage("user", "test 3");

      const results = service.search("test");

      expect(results).toHaveLength(3);
      expect(results[0].payload.content).toBe("test 3");
      expect(results[2].payload.content).toBe("test 1");
    });

    it("should respect limit", () => {
      for (let i = 0; i < 10; i++) {
        service.appendMessage("user", `message ${i}`);
      }

      const results = service.search("message", 3);

      expect(results).toHaveLength(3);
    });
  });

  describe("forkTape + mergeFork", () => {
    it("should fork tape and merge new entries", () => {
      service.appendMessage("user", "Original");

      const { forkName } = service.forkTape();

      // Append to fork
      const forkService = new TapeService(forkName, store);
      forkService.appendMessage("user", "Fork message");
      forkService.appendMessage("assistant", "Fork response");

      // Merge fork back
      service.mergeFork(forkName);

      // Main should have all entries
      const entries = service.readAll();
      expect(entries).toHaveLength(3);
      expect(entries![0].payload.content).toBe("Original");
      expect(entries![1].payload.content).toBe("Fork message");
      expect(entries![2].payload.content).toBe("Fork response");
    });

    it("should restore discard fork", () => {
      service.appendMessage("user", "Original");

      const { forkName, restore } = service.forkTape();

      // Append to fork
      const forkService = new TapeService(forkName, store);
      forkService.appendMessage("user", "Fork message");

      // Restore (discard fork)
      restore();

      // Main should still have only original
      const entries = service.readAll();
      expect(entries).toHaveLength(1);
      expect(entries![0].payload.content).toBe("Original");
    });
  });
});

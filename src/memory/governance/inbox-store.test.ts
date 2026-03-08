import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryInboxStore, toUtcDateString, dateRange } from "./inbox-store";
import { buildCandidate } from "./normalization";
import type { MemoryCandidate } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(
  overrides: Partial<MemoryCandidate> = {}
): MemoryCandidate {
  return buildCandidate({
    ts: "2024-03-15T10:00:00Z",
    agentId: "agent1",
    source: "turn_completed",
    category: "preference",
    summary: "prefer dark mode",
    evidence: ["user_explicit"],
    confidence: 0.9,
    stability: "high",
    scopeHint: "long_term_candidate",
    promoteCandidate: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// toUtcDateString
// ---------------------------------------------------------------------------

describe("toUtcDateString", () => {
  it("formats an ISO string to YYYY-MM-DD (UTC)", () => {
    expect(toUtcDateString("2024-03-15T23:59:00Z")).toBe("2024-03-15");
  });

  it("handles midnight boundary correctly", () => {
    expect(toUtcDateString("2024-03-16T00:00:00Z")).toBe("2024-03-16");
  });

  it("accepts a Date object", () => {
    expect(toUtcDateString(new Date("2024-06-01T12:00:00Z"))).toBe(
      "2024-06-01"
    );
  });
});

// ---------------------------------------------------------------------------
// dateRange
// ---------------------------------------------------------------------------

describe("dateRange", () => {
  it("returns a single date when from === to", () => {
    expect(dateRange("2024-03-15", "2024-03-15")).toEqual(["2024-03-15"]);
  });

  it("returns inclusive range across multiple days", () => {
    expect(dateRange("2024-03-13", "2024-03-15")).toEqual([
      "2024-03-13",
      "2024-03-14",
      "2024-03-15",
    ]);
  });

  it("returns empty array when from > to", () => {
    expect(dateRange("2024-03-15", "2024-03-14")).toEqual([]);
  });

  it("handles month boundary", () => {
    const range = dateRange("2024-02-28", "2024-03-01");
    expect(range).toEqual(["2024-02-28", "2024-02-29", "2024-03-01"]);
  });
});

// ---------------------------------------------------------------------------
// MemoryInboxStore – file I/O tests
// ---------------------------------------------------------------------------

describe("MemoryInboxStore", () => {
  let tmpDir: string;
  let store: MemoryInboxStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "inbox-store-test-"));
    store = new MemoryInboxStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // append – basic write
  // -------------------------------------------------------------------------

  describe("append", () => {
    it("writes a candidate and it can be read back", async () => {
      const c = makeCandidate();
      await store.append(c);

      const shard = await store.readShard("2024-03-15");
      expect(shard).toHaveLength(1);
      expect(shard[0].id).toBe(c.id);
      expect(shard[0].summary).toBe(c.summary);
    });

    it("defaults status to pending when not provided", async () => {
      const c = makeCandidate();
      // Ensure no status set
      const { status: _drop, ...withoutStatus } = c;
      await store.append(withoutStatus as MemoryCandidate);

      const [record] = await store.readShard("2024-03-15");
      expect(record.status).toBe("pending");
    });

    it("preserves explicit status when provided", async () => {
      const c = makeCandidate({ status: "accepted_daily" });
      await store.append(c);

      const [record] = await store.readShard("2024-03-15");
      expect(record.status).toBe("accepted_daily");
    });

    it("places candidate in the shard matching its UTC date", async () => {
      const c1 = makeCandidate({ ts: "2024-03-15T10:00:00Z" });
      const c2 = makeCandidate({
        ts: "2024-03-16T10:00:00Z",
        summary: "use pnpm not npm",
      });

      await store.append(c1);
      await store.append(c2);

      expect(await store.readShard("2024-03-15")).toHaveLength(1);
      expect(await store.readShard("2024-03-16")).toHaveLength(1);
    });

    it("stores multiple distinct candidates in one shard", async () => {
      const c1 = makeCandidate({ summary: "prefer dark mode" });
      const c2 = makeCandidate({ summary: "use pnpm not npm" });

      await store.append(c1);
      await store.append(c2);

      const shard = await store.readShard("2024-03-15");
      expect(shard).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe("idempotency – same ID written twice", () => {
    it("does not create a duplicate record", async () => {
      const c = makeCandidate();
      await store.append(c);
      await store.append(c); // second write with same id

      const shard = await store.readShard("2024-03-15");
      expect(shard).toHaveLength(1);
    });

    it("same candidate from different sources on same day shares the same ID and dedupes", async () => {
      // buildCandidate generates ID from dedupeKey+day, not from source
      const fromTurn = makeCandidate({ source: "turn_completed" });
      const fromReset = makeCandidate({ source: "before_reset" });

      // They must share the same ID (cross-path idempotency per spec)
      expect(fromTurn.id).toBe(fromReset.id);

      await store.append(fromTurn);
      await store.append(fromReset);

      const shard = await store.readShard("2024-03-15");
      expect(shard).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // appendMany
  // -------------------------------------------------------------------------

  describe("appendMany", () => {
    it("appends multiple candidates in one call", async () => {
      const candidates = [
        makeCandidate({ summary: "fact one" }),
        makeCandidate({ summary: "fact two" }),
        makeCandidate({ summary: "fact three" }),
      ];
      await store.appendMany(candidates);

      const shard = await store.readShard("2024-03-15");
      expect(shard).toHaveLength(3);
    });

    it("is idempotent across appendMany calls", async () => {
      const c = makeCandidate();
      await store.appendMany([c]);
      await store.appendMany([c]);

      const shard = await store.readShard("2024-03-15");
      expect(shard).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // updateStatus
  // -------------------------------------------------------------------------

  describe("updateStatus", () => {
    it("updates the status of an existing candidate", async () => {
      const c = makeCandidate();
      await store.append(c);

      const ok = await store.updateStatus(c.id, c.ts, "accepted_daily");
      expect(ok).toBe(true);

      const [record] = await store.readShard("2024-03-15");
      expect(record.status).toBe("accepted_daily");
    });

    it("stores a rejectionReason when provided", async () => {
      const c = makeCandidate();
      await store.append(c);

      await store.updateStatus(c.id, c.ts, "rejected", "transcript-like content");

      const [record] = await store.readShard("2024-03-15");
      expect(record.status).toBe("rejected");
      expect(record.rejectionReason).toBe("transcript-like content");
    });

    it("returns false when the candidate ID is not found", async () => {
      const ok = await store.updateStatus(
        "nonexistent-id",
        "2024-03-15T10:00:00Z",
        "rejected"
      );
      expect(ok).toBe(false);
    });

    it("does not affect other records in the same shard", async () => {
      const c1 = makeCandidate({ summary: "fact one" });
      const c2 = makeCandidate({ summary: "fact two" });
      await store.appendMany([c1, c2]);

      await store.updateStatus(c1.id, c1.ts, "rejected", "reason");

      const shard = await store.readShard("2024-03-15");
      const rec1 = shard.find((r) => r.id === c1.id)!;
      const rec2 = shard.find((r) => r.id === c2.id)!;

      expect(rec1.status).toBe("rejected");
      expect(rec2.status).toBe("pending");
    });

    it("survives a second status transition (accepted_daily -> promoted)", async () => {
      const c = makeCandidate();
      await store.append(c);
      await store.updateStatus(c.id, c.ts, "accepted_daily");
      await store.updateStatus(c.id, c.ts, "promoted");

      const [record] = await store.readShard("2024-03-15");
      expect(record.status).toBe("promoted");
    });
  });

  // -------------------------------------------------------------------------
  // scan
  // -------------------------------------------------------------------------

  describe("scan", () => {
    beforeEach(async () => {
      // Seed three shards
      const c1 = makeCandidate({
        ts: "2024-03-13T10:00:00Z",
        summary: "fact day 1",
        status: "pending",
      });
      const c2 = makeCandidate({
        ts: "2024-03-14T10:00:00Z",
        summary: "fact day 2",
        status: "accepted_daily",
      });
      const c3 = makeCandidate({
        ts: "2024-03-15T10:00:00Z",
        summary: "fact day 3",
        status: "rejected",
      });
      await store.appendMany([c1, c2, c3]);
    });

    it("returns all candidates across the date range when no status filter", async () => {
      const results = await store.scan({
        fromDate: "2024-03-13",
        toDate: "2024-03-15",
      });
      expect(results).toHaveLength(3);
    });

    it("filters by status", async () => {
      const pending = await store.scan({
        fromDate: "2024-03-13",
        toDate: "2024-03-15",
        status: "pending",
      });
      expect(pending).toHaveLength(1);
      expect(pending[0].summary).toBe("fact day 1");
    });

    it("returns empty array when no shards exist in range", async () => {
      const results = await store.scan({
        fromDate: "2020-01-01",
        toDate: "2020-01-03",
      });
      expect(results).toHaveLength(0);
    });

    it("results are in chronological shard order", async () => {
      const results = await store.scan({
        fromDate: "2024-03-13",
        toDate: "2024-03-15",
      });
      const dates = results.map((r) => r.ts.slice(0, 10));
      expect(dates).toEqual(["2024-03-13", "2024-03-14", "2024-03-15"]);
    });
  });

  // -------------------------------------------------------------------------
  // scanPending
  // -------------------------------------------------------------------------

  describe("scanPending", () => {
    it("returns only pending candidates", async () => {
      const pending = makeCandidate({ status: "pending" });
      const accepted = makeCandidate({
        summary: "use pnpm",
        status: "accepted_daily",
      });
      await store.appendMany([pending, accepted]);

      const results = await store.scanPending("2024-03-15", "2024-03-15");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(pending.id);
    });
  });

  // -------------------------------------------------------------------------
  // Crash-safety: partial write does not corrupt shard
  // -------------------------------------------------------------------------

  describe("atomicity", () => {
    it("shard is fully readable after an updateStatus rewrite", async () => {
      // Write 5 candidates then update one – verifies the atomic rewrite path
      const candidates = Array.from({ length: 5 }, (_, i) =>
        makeCandidate({ summary: `fact ${i}` })
      );
      await store.appendMany(candidates);

      const target = candidates[2];
      await store.updateStatus(target.id, target.ts, "promoted");

      const shard = await store.readShard("2024-03-15");
      expect(shard).toHaveLength(5);

      const updated = shard.find((c) => c.id === target.id)!;
      expect(updated.status).toBe("promoted");
    });
  });
});

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MoziConfig } from "../config";
import type { SessionState } from "./types";

const SESSION_STORE_FILE = "sessions.json";

type SessionStoreEntry = {
  agentId: string;
  createdAt: number;
  updatedAt: number;
  currentModel?: string;
  metadata?: Record<string, unknown>;
  latestSessionId: string;
  latestSessionFile: string;
  historySessionIds: string[];
  segments: Record<string, SessionSegmentMeta>;
  // Compatibility aliases used by old code paths/readers.
  sessionId?: string;
  sessionFile?: string;
};

type SessionSegmentMeta = {
  sessionId: string;
  sessionFile: string;
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
  summary?: string;
  prevSessionId?: string;
  nextSessionId?: string;
};

type TranscriptHeader = {
  type: "session";
  sessionId: string;
  sessionKey: string;
  agentId: string;
  createdAt: number;
  updatedAt?: number;
  archived?: boolean;
  prevSessionId?: string;
  nextSessionId?: string;
  model?: string;
  metadata?: Record<string, unknown>;
};

type TranscriptMessage = {
  type: "message";
  message: unknown;
};

export class SessionStore {
  private sessionsDir: string;
  private storePath: string;
  private cache = new Map<string, SessionState>();

  constructor(config: MoziConfig) {
    let base = config.paths?.sessions;
    if (!base) {
      const tempBase = path.join(os.tmpdir(), "mozi");
      base = path.join(tempBase, "sessions");
    }
    if (!path.isAbsolute(base)) {
      if (config.paths?.baseDir) {
        base = path.resolve(config.paths.baseDir, base);
      } else {
        base = path.resolve(base);
      }
    }
    this.sessionsDir = base;
    this.storePath = path.join(this.sessionsDir, SESSION_STORE_FILE);
  }

  get(sessionKey: string): SessionState | undefined {
    return this.cache.get(sessionKey);
  }

  getOrCreate(sessionKey: string, agentId: string): SessionState {
    const cached = this.cache.get(sessionKey);
    if (cached) {
      return cached;
    }

    const store = this.loadStore();
    const existingRaw = store[sessionKey];
    const existing = existingRaw ? this.normalizeEntry(existingRaw, agentId) : undefined;
    if (existing) {
      const transcript = this.readTranscript(existing.latestSessionFile);
      const state: SessionState = {
        sessionKey,
        agentId: existing.agentId,
        latestSessionId: existing.latestSessionId,
        latestSessionFile: existing.latestSessionFile,
        historySessionIds: existing.historySessionIds,
        segments: this.toSessionStateSegments(existing.segments),
        sessionId: existing.latestSessionId,
        sessionFile: existing.latestSessionFile,
        currentModel: existing.currentModel,
        metadata: existing.metadata,
        context: transcript.messages,
        createdAt: existing.createdAt || existing.updatedAt || Date.now(),
        updatedAt: existing.updatedAt || existing.createdAt || Date.now(),
      };
      this.cache.set(sessionKey, state);
      return state;
    }

    const sessionId = crypto.randomUUID();
    const sessionFile = this.resolveSessionFile(agentId, sessionId);
    const now = Date.now();

    const firstSegment: SessionSegmentMeta = {
      sessionId,
      sessionFile,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };

    const entry: SessionStoreEntry = {
      agentId,
      createdAt: now,
      updatedAt: now,
      metadata: {},
      latestSessionId: sessionId,
      latestSessionFile: sessionFile,
      historySessionIds: [],
      segments: {
        [sessionId]: firstSegment,
      },
      sessionId,
      sessionFile,
    };
    store[sessionKey] = entry;
    this.saveStore(store);

    const header: TranscriptHeader = {
      type: "session",
      sessionId,
      sessionKey,
      agentId,
      createdAt: now,
      metadata: {},
    };
    this.writeTranscript(sessionFile, header, []);

    const created: SessionState = {
      sessionKey,
      agentId,
      latestSessionId: sessionId,
      latestSessionFile: sessionFile,
      historySessionIds: [],
      segments: this.toSessionStateSegments(entry.segments),
      sessionId,
      sessionFile,
      createdAt: now,
      updatedAt: now,
      context: [],
    };
    this.cache.set(sessionKey, created);
    return created;
  }

  update(sessionKey: string, changes: Partial<SessionState>): SessionState | undefined {
    const current = this.cache.get(sessionKey);
    if (!current) {
      return undefined;
    }

    const now = Date.now();
    const next: SessionState = { ...current, ...changes };
    next.createdAt = next.createdAt || current.createdAt || now;
    next.updatedAt = now;
    next.latestSessionId = next.latestSessionId || next.sessionId || current.latestSessionId;
    next.latestSessionFile =
      next.latestSessionFile || next.sessionFile || current.latestSessionFile;
    next.sessionId = next.latestSessionId;
    next.sessionFile = next.latestSessionFile;

    const store = this.loadStore();
    let entry = store[sessionKey]
      ? this.normalizeEntry(store[sessionKey], next.agentId)
      : undefined;

    if (!entry) {
      const segmentId = next.latestSessionId || crypto.randomUUID();
      const segmentFile =
        next.latestSessionFile || this.resolveSessionFile(next.agentId, segmentId);
      entry = {
        agentId: next.agentId,
        createdAt: next.createdAt || now,
        updatedAt: next.updatedAt || now,
        currentModel: next.currentModel,
        metadata: next.metadata,
        latestSessionId: segmentId,
        latestSessionFile: segmentFile,
        historySessionIds: [],
        segments: {
          [segmentId]: {
            sessionId: segmentId,
            sessionFile: segmentFile,
            createdAt: next.createdAt || now,
            updatedAt: next.updatedAt || now,
            archived: false,
          },
        },
        sessionId: segmentId,
        sessionFile: segmentFile,
      };
    } else {
      entry.currentModel = next.currentModel;
      entry.metadata = next.metadata;
      entry.createdAt = entry.createdAt || next.createdAt || now;
      entry.updatedAt = next.updatedAt || entry.updatedAt;
      entry.agentId = next.agentId;

      const latestSessionId = next.latestSessionId || entry.latestSessionId;
      const latestSessionFile =
        next.latestSessionFile ||
        next.sessionFile ||
        entry.latestSessionFile ||
        this.resolveSessionFile(next.agentId, latestSessionId);

      entry.latestSessionId = latestSessionId;
      entry.latestSessionFile = latestSessionFile;
      entry.historySessionIds = Array.from(
        new Set(
          Array.isArray(next.historySessionIds)
            ? next.historySessionIds
            : entry.historySessionIds || [],
        ),
      );

      const nextSegments = this.mergeSegmentsForStore({
        current: entry.segments,
        incoming: next.segments,
      });
      const latestSegment = nextSegments[latestSessionId] || {
        sessionId: latestSessionId,
        sessionFile: latestSessionFile,
        createdAt: entry.createdAt || now,
        updatedAt: now,
      };
      nextSegments[latestSessionId] = {
        ...latestSegment,
        sessionFile: latestSessionFile,
        updatedAt: now,
        archived: false,
      };
      entry.segments = nextSegments;
      entry.sessionId = latestSessionId;
      entry.sessionFile = latestSessionFile;
    }

    store[sessionKey] = entry;
    this.saveStore(store);

    if (entry.latestSessionFile) {
      const latestMeta = entry.segments[entry.latestSessionId];
      const header: TranscriptHeader = {
        type: "session",
        sessionId: entry.latestSessionId,
        sessionKey: next.sessionKey,
        agentId: entry.agentId,
        createdAt: latestMeta?.createdAt || next.createdAt || entry.createdAt || now,
        updatedAt: now,
        archived: latestMeta?.archived,
        prevSessionId: latestMeta?.prevSessionId,
        nextSessionId: latestMeta?.nextSessionId,
        model: entry.currentModel,
        metadata: entry.metadata,
      };
      const messages = Array.isArray(next.context) ? next.context : [];
      this.writeTranscript(entry.latestSessionFile, header, messages);
    }

    const persisted: SessionState = {
      ...next,
      latestSessionId: entry.latestSessionId,
      latestSessionFile: entry.latestSessionFile,
      historySessionIds: entry.historySessionIds,
      segments: this.toSessionStateSegments(entry.segments),
      sessionId: entry.latestSessionId,
      sessionFile: entry.latestSessionFile,
      currentModel: entry.currentModel,
      metadata: entry.metadata,
    };

    this.cache.set(sessionKey, persisted);
    return persisted;
  }

  list(): SessionState[] {
    return Array.from(this.cache.values());
  }

  rotateSegment(sessionKey: string, agentId: string): SessionState {
    const current = this.getOrCreate(sessionKey, agentId);
    const store = this.loadStore();
    const now = Date.now();
    const fallbackLatestId = current.latestSessionId || current.sessionId || crypto.randomUUID();

    const existing = store[sessionKey]
      ? this.normalizeEntry(store[sessionKey], current.agentId)
      : this.normalizeEntry(
          {
            agentId: current.agentId,
            createdAt: current.createdAt || now,
            updatedAt: current.updatedAt || now,
            currentModel: current.currentModel,
            metadata: current.metadata,
            latestSessionId: fallbackLatestId,
            latestSessionFile:
              current.latestSessionFile ||
              current.sessionFile ||
              this.resolveSessionFile(current.agentId, fallbackLatestId),
            historySessionIds: current.historySessionIds || [],
            segments: this.mergeSegmentsForStore({ current: {}, incoming: current.segments }),
          },
          current.agentId,
        );

    const previousLatestId = existing.latestSessionId;
    const previousLatest = existing.segments[previousLatestId];
    if (previousLatest) {
      existing.segments[previousLatestId] = {
        ...previousLatest,
        archived: true,
        updatedAt: now,
      };
      existing.historySessionIds = Array.from(
        new Set([...(existing.historySessionIds || []), previousLatestId]),
      );
    }

    const nextSessionId = crypto.randomUUID();
    const nextSessionFile = this.resolveSessionFile(existing.agentId, nextSessionId);
    existing.latestSessionId = nextSessionId;
    existing.latestSessionFile = nextSessionFile;
    existing.updatedAt = now;
    existing.sessionId = nextSessionId;
    existing.sessionFile = nextSessionFile;
    existing.segments[nextSessionId] = {
      sessionId: nextSessionId,
      sessionFile: nextSessionFile,
      createdAt: now,
      updatedAt: now,
      archived: false,
      prevSessionId: previousLatestId,
    };
    if (previousLatestId && existing.segments[previousLatestId]) {
      existing.segments[previousLatestId] = {
        ...existing.segments[previousLatestId],
        nextSessionId,
      };
    }

    const nextHeader: TranscriptHeader = {
      type: "session",
      sessionId: nextSessionId,
      sessionKey,
      agentId: existing.agentId,
      createdAt: now,
      updatedAt: now,
      prevSessionId: previousLatestId,
      model: undefined,
      metadata: existing.metadata,
    };
    this.writeTranscript(nextSessionFile, nextHeader, []);

    store[sessionKey] = existing;
    this.saveStore(store);

    const rotated: SessionState = {
      ...current,
      sessionKey,
      agentId: existing.agentId,
      latestSessionId: nextSessionId,
      latestSessionFile: nextSessionFile,
      historySessionIds: existing.historySessionIds,
      segments: this.toSessionStateSegments(existing.segments),
      sessionId: nextSessionId,
      sessionFile: nextSessionFile,
      context: [],
      currentModel: undefined,
      updatedAt: now,
    };
    this.cache.set(sessionKey, rotated);
    return rotated;
  }

  revertToPreviousSegment(sessionKey: string, agentId: string): SessionState | undefined {
    const current = this.getOrCreate(sessionKey, agentId);
    const store = this.loadStore();
    const now = Date.now();
    const entry = store[sessionKey]
      ? this.normalizeEntry(store[sessionKey], current.agentId)
      : undefined;
    if (!entry) {
      return undefined;
    }

    const currentLatestId = entry.latestSessionId;
    const currentLatest = entry.segments[currentLatestId];
    const previousId = currentLatest?.prevSessionId;
    if (!previousId) {
      return undefined;
    }
    const previous = entry.segments[previousId];
    if (!previous) {
      return undefined;
    }

    const previousTranscript = this.readTranscript(previous.sessionFile);
    const currentTranscript = this.readTranscript(entry.latestSessionFile);
    const mergedMessages = [...previousTranscript.messages, ...currentTranscript.messages];

    entry.latestSessionId = previousId;
    entry.latestSessionFile = previous.sessionFile;
    entry.sessionId = previousId;
    entry.sessionFile = previous.sessionFile;
    entry.updatedAt = now;

    entry.segments[previousId] = {
      ...previous,
      archived: false,
      updatedAt: now,
      nextSessionId: undefined,
    };
    entry.segments[currentLatestId] = {
      ...currentLatest,
      archived: true,
      updatedAt: now,
    };
    entry.historySessionIds = Array.from(
      new Set([...(entry.historySessionIds || []), currentLatestId]),
    );

    const header: TranscriptHeader = {
      type: "session",
      sessionId: previousId,
      sessionKey,
      agentId: entry.agentId,
      createdAt: previous.createdAt,
      updatedAt: now,
      archived: false,
      prevSessionId: previous.prevSessionId,
      model: entry.currentModel,
      metadata: entry.metadata,
    };
    this.writeTranscript(previous.sessionFile, header, mergedMessages);

    store[sessionKey] = entry;
    this.saveStore(store);

    const reverted: SessionState = {
      ...current,
      agentId: entry.agentId,
      latestSessionId: previousId,
      latestSessionFile: previous.sessionFile,
      historySessionIds: entry.historySessionIds,
      segments: this.toSessionStateSegments(entry.segments),
      sessionId: previousId,
      sessionFile: previous.sessionFile,
      context: mergedMessages,
      updatedAt: now,
    };
    this.cache.set(sessionKey, reverted);
    return reverted;
  }

  private resolveSessionFile(agentId: string, sessionId: string): string {
    const dir = path.join(this.sessionsDir, agentId);
    return path.join(dir, `${sessionId}.jsonl`);
  }

  private loadStore(): Record<string, SessionStoreEntry> {
    try {
      const raw = fs.readFileSync(this.storePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, SessionStoreEntry>;
      }
      return {};
    } catch {
      return {};
    }
  }

  private saveStore(store: Record<string, SessionStoreEntry>): void {
    this.ensureDir(this.storePath);
    const json = JSON.stringify(store, null, 2);
    fs.writeFileSync(this.storePath, json, "utf-8");
  }

  private readTranscript(sessionFile: string): { header?: TranscriptHeader; messages: unknown[] } {
    try {
      const raw = fs.readFileSync(sessionFile, "utf-8");
      const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      let header: TranscriptHeader | undefined;
      const messages: unknown[] = [];
      for (const line of lines) {
        try {
          const payload = JSON.parse(line) as TranscriptHeader | TranscriptMessage;
          if (payload && payload.type === "session") {
            header = payload;
          } else if (payload && payload.type === "message") {
            messages.push(payload.message);
          }
        } catch {
          continue;
        }
      }
      return { header, messages };
    } catch {
      return { messages: [] };
    }
  }

  private writeTranscript(
    sessionFile: string,
    header: TranscriptHeader,
    messages: unknown[],
  ): void {
    this.ensureDir(sessionFile);
    const lines: string[] = [JSON.stringify(header)];
    for (const message of messages) {
      const payload: TranscriptMessage = { type: "message", message };
      lines.push(JSON.stringify(payload));
    }
    fs.writeFileSync(sessionFile, lines.join("\n") + "\n", "utf-8");
  }

  private ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
  }

  private normalizeEntry(raw: SessionStoreEntry, fallbackAgentId: string): SessionStoreEntry {
    const now = Date.now();
    const agentId = raw.agentId || fallbackAgentId;
    const latestSessionId = raw.latestSessionId || raw.sessionId || crypto.randomUUID();
    const latestSessionFile =
      raw.latestSessionFile || raw.sessionFile || this.resolveSessionFile(agentId, latestSessionId);

    const segments: Record<string, SessionSegmentMeta> = raw.segments
      ? { ...raw.segments }
      : {
          [latestSessionId]: {
            sessionId: latestSessionId,
            sessionFile: latestSessionFile,
            createdAt: raw.createdAt || now,
            updatedAt: raw.updatedAt || now,
            archived: false,
          },
        };

    if (!segments[latestSessionId]) {
      segments[latestSessionId] = {
        sessionId: latestSessionId,
        sessionFile: latestSessionFile,
        createdAt: raw.createdAt || now,
        updatedAt: raw.updatedAt || now,
        archived: false,
      };
    }

    const historySessionIds = Array.isArray(raw.historySessionIds)
      ? raw.historySessionIds.filter((id) => id && id !== latestSessionId)
      : [];

    return {
      agentId,
      createdAt: raw.createdAt || now,
      updatedAt: raw.updatedAt || raw.createdAt || now,
      currentModel: raw.currentModel,
      metadata: raw.metadata,
      latestSessionId,
      latestSessionFile,
      historySessionIds,
      segments,
      sessionId: latestSessionId,
      sessionFile: latestSessionFile,
    };
  }

  private mergeSegmentsForStore(params: {
    current: Record<string, SessionSegmentMeta>;
    incoming: SessionState["segments"];
  }): Record<string, SessionSegmentMeta> {
    const merged: Record<string, SessionSegmentMeta> = { ...params.current };
    const incoming = params.incoming;
    if (!incoming) {
      return merged;
    }
    for (const [segmentId, value] of Object.entries(incoming)) {
      if (!value || !value.sessionFile) {
        continue;
      }
      const existing = merged[segmentId];
      if (existing?.archived) {
        // Archived segments are immutable once rotated out of latest.
        continue;
      }
      merged[segmentId] = {
        ...existing,
        sessionId: segmentId,
        sessionFile: value.sessionFile,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        archived: value.archived,
        summary: value.summary,
        prevSessionId: value.prevSessionId,
        nextSessionId: value.nextSessionId,
      };
    }
    return merged;
  }

  private toSessionStateSegments(
    segments: Record<string, SessionSegmentMeta>,
  ): SessionState["segments"] {
    const result: NonNullable<SessionState["segments"]> = {};
    for (const [id, segment] of Object.entries(segments)) {
      result[id] = {
        sessionId: segment.sessionId,
        sessionFile: segment.sessionFile,
        createdAt: segment.createdAt,
        updatedAt: segment.updatedAt,
        archived: segment.archived,
        summary: segment.summary,
        prevSessionId: segment.prevSessionId,
        nextSessionId: segment.nextSessionId,
      };
    }
    return result;
  }
}

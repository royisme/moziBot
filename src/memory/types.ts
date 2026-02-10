export type MemorySource = "memory" | "sessions";

export interface SearchOptions {
  maxResults?: number;
  minScore?: number;
  sessionKey?: string;
}

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
}

export interface ReadFileParams {
  relPath: string;
  from?: number;
  lines?: number;
}

export interface ReadFileResult {
  text: string;
  path: string;
}

export interface MemoryProviderStatus {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  fallback?: { from: string; reason?: string };
  fts?: { enabled: boolean; available: boolean; error?: string };
  vector?: {
    enabled: boolean;
    available?: boolean;
    dims?: number;
  };
  custom?: Record<string, unknown>;
}

export interface MemoryEmbeddingProbeResult {
  ok: boolean;
  error?: string;
}

export interface MemorySyncProgressUpdate {
  completed: number;
  total: number;
  label?: string;
}

export interface SyncParams {
  reason?: string;
  force?: boolean;
  progress?: (update: MemorySyncProgressUpdate) => void;
}

export interface MemorySearchManager {
  search(query: string, opts?: SearchOptions): Promise<MemorySearchResult[]>;
  readFile(params: ReadFileParams): Promise<ReadFileResult>;
  status(): MemoryProviderStatus;
  warmSession?(sessionKey?: string): Promise<void>;
  markDirty?(): void;
  sync?(params?: SyncParams): Promise<void>;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}

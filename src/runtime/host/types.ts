export interface ComponentStatus {
  name: string;
  status: "healthy" | "degraded" | "unhealthy";
  lastCheck: Date;
  details?: Record<string, unknown>;
}

export interface RuntimeStatus {
  running: boolean;
  pid: number | null;
  uptime: number; // in seconds
  startedAt: Date | null;
  health: {
    overall: "healthy" | "degraded" | "unhealthy";
    components: ComponentStatus[];
  };
  sessions: {
    total: number;
    active: number;
    queued: number;
    retrying: number;
  };
  queue: {
    pending: number;
  };
}

export interface RuntimeHostOptions {
  daemon?: boolean;
}

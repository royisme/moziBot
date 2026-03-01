import type { RunRecord, RunState, TerminationReason } from "./types.js";

const MAX_RECORDS = 2000;

export type RunRegistry = {
  add(record: RunRecord): void;
  get(runId: string): RunRecord | undefined;
  updateState(
    runId: string,
    state: RunState,
    extra?: {
      pid?: number;
      terminationReason?: TerminationReason;
      exitCode?: number | null;
      exitSignal?: NodeJS.Signals | number | null;
    },
  ): void;
  touchOutput(runId: string): void;
  finalize(
    runId: string,
    info: {
      reason: TerminationReason;
      exitCode: number | null;
      exitSignal: NodeJS.Signals | number | null;
    },
  ): void;
  list(): RunRecord[];
};

export function createRunRegistry(): RunRegistry {
  const records = new Map<string, RunRecord>();

  const prune = () => {
    if (records.size <= MAX_RECORDS) {
      return;
    }
    const exited = [...records.values()]
      .filter((r) => r.state === "exited")
      .toSorted((a, b) => a.updatedAtMs - b.updatedAtMs);
    const toDelete = records.size - MAX_RECORDS;
    for (let i = 0; i < toDelete && i < exited.length; i++) {
      records.delete(exited[i].runId);
    }
  };

  const add = (record: RunRecord) => {
    records.set(record.runId, { ...record });
    prune();
  };

  const get = (runId: string) => records.get(runId);

  const updateState = (
    runId: string,
    state: RunState,
    extra?: {
      pid?: number;
      terminationReason?: TerminationReason;
      exitCode?: number | null;
      exitSignal?: NodeJS.Signals | number | null;
    },
  ) => {
    const record = records.get(runId);
    if (!record) {
      return;
    }
    record.state = state;
    record.updatedAtMs = Date.now();
    if (extra?.pid !== undefined) {
      record.pid = extra.pid;
    }
    if (extra?.terminationReason !== undefined) {
      record.terminationReason = extra.terminationReason;
    }
    if (extra?.exitCode !== undefined) {
      record.exitCode = extra.exitCode;
    }
    if (extra?.exitSignal !== undefined) {
      record.exitSignal = extra.exitSignal;
    }
  };

  const touchOutput = (runId: string) => {
    const record = records.get(runId);
    if (!record) {
      return;
    }
    const now = Date.now();
    record.lastOutputAtMs = now;
    record.updatedAtMs = now;
  };

  const finalize = (
    runId: string,
    info: {
      reason: TerminationReason;
      exitCode: number | null;
      exitSignal: NodeJS.Signals | number | null;
    },
  ) => {
    updateState(runId, "exited", {
      terminationReason: info.reason,
      exitCode: info.exitCode,
      exitSignal: info.exitSignal,
    });
  };

  const list = () => [...records.values()];

  return { add, get, updateState, touchOutput, finalize, list };
}

/**
 * Shared doctor framework types
 * Used by both general doctor and ACP doctor flows
 */

import type { MoziConfig } from "../../config/schema";

export type DoctorFindingLevel = "pass" | "warn" | "fail";

export interface DoctorFinding {
  /** Unique identifier for this finding type */
  id: string;
  /** Severity level of the finding */
  level: DoctorFindingLevel;
  /** Brief summary of the finding */
  summary: string;
  /** Optional detailed information */
  details?: string;
  /** Optional hint for fixing the issue */
  fixHint?: string;
}

export interface DoctorReport {
  /** List of findings from all checks */
  findings: DoctorFinding[];
  /** Whether the config passed all checks */
  passed: boolean;
  /** Count of findings by level */
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
}

export interface DoctorOptions {
  /** Config file path */
  configPath?: string;
  /** Attempt to fix issues */
  fix?: boolean;
  /** Output in JSON format */
  json?: boolean;
  /** Verbose output */
  verbose?: boolean;
}

export type DoctorCheck = (
  config: unknown,
  context: DoctorCheckContext,
) => Promise<DoctorFinding[]>;

export interface DoctorCheckContext {
  config: MoziConfig;
  fix: boolean;
}

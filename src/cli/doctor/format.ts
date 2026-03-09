/**
 * Doctor output formatters
 * Supports both human-readable and JSON output
 */

import type { DoctorReport, DoctorFinding } from "./types";

/**
 * Print doctor report to appropriate streams.
 * In non-JSON mode:
 * - Failures go to stderr (console.error)
 * - Warnings go to stderr (console.warn)
 * - Summary and passes go to stdout (console.log)
 */
export function printDoctorReport(
  report: DoctorReport,
  options: { json?: boolean; verbose?: boolean } = {},
): void {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Summary line goes to stdout
  if (report.passed) {
    console.log("✅ Config check passed. The config is runnable.");
  } else {
    console.error("❌ Config check failed with blocking issues:");
  }

  // Group findings by level
  const fails = report.findings.filter((f) => f.level === "fail");
  const warns = report.findings.filter((f) => f.level === "warn");
  const passes = report.findings.filter((f) => f.level === "pass");

  // Print failures to stderr
  for (const finding of fails) {
    console.error(`- ${finding.summary}`);
    if (options.verbose && finding.details) {
      console.error(`  Details: ${finding.details}`);
    }
    if (finding.fixHint) {
      console.error(`  Fix: ${finding.fixHint}`);
    }
  }

  // Print warnings to stderr
  if (warns.length > 0) {
    console.error("");
    console.error("⚠️ Warnings:");
    for (const finding of warns) {
      console.error(`- ${finding.summary}`);
      if (options.verbose && finding.details) {
        console.error(`  Details: ${finding.details}`);
      }
      if (finding.fixHint) {
        console.error(`  Fix: ${finding.fixHint}`);
      }
    }
  }

  // Print passes in verbose mode to stdout
  if (options.verbose && passes.length > 0) {
    console.log("");
    console.log("ℹ️ Passed checks:");
    for (const finding of passes) {
      console.log(`- ${finding.summary}`);
    }
  }
}

export function formatDoctorReport(
  report: DoctorReport,
  options: { json?: boolean; verbose?: boolean } = {},
): string {
  if (options.json) {
    return JSON.stringify(report, null, 2);
  }

  const lines: string[] = [];

  // Summary line
  if (report.passed) {
    lines.push("✅ Config check passed. The config is runnable.");
  } else {
    lines.push("❌ Config check failed with blocking issues:");
  }

  // Group findings by level
  const fails = report.findings.filter((f) => f.level === "fail");
  const warns = report.findings.filter((f) => f.level === "warn");
  const passes = report.findings.filter((f) => f.level === "pass");

  // Print failures
  for (const finding of fails) {
    lines.push(`- ${finding.summary}`);
    if (options.verbose && finding.details) {
      lines.push(`  Details: ${finding.details}`);
    }
    if (finding.fixHint) {
      lines.push(`  Fix: ${finding.fixHint}`);
    }
  }

  // Print warnings
  if (warns.length > 0) {
    if (fails.length > 0) {
      lines.push("");
    }
    lines.push("⚠️ Warnings:");
    for (const finding of warns) {
      lines.push(`- ${finding.summary}`);
      if (options.verbose && finding.details) {
        lines.push(`  Details: ${finding.details}`);
      }
      if (finding.fixHint) {
        lines.push(`  Fix: ${finding.fixHint}`);
      }
    }
  }

  // Print passes in verbose mode
  if (options.verbose && passes.length > 0) {
    if (fails.length > 0 || warns.length > 0) {
      lines.push("");
    }
    lines.push("ℹ️ Passed checks:");
    for (const finding of passes) {
      lines.push(`- ${finding.summary}`);
    }
  }

  return lines.join("\n");
}

export function createDoctorReport(findings: DoctorFinding[]): DoctorReport {
  const summary = {
    pass: findings.filter((f) => f.level === "pass").length,
    warn: findings.filter((f) => f.level === "warn").length,
    fail: findings.filter((f) => f.level === "fail").length,
  };

  return {
    findings,
    passed: summary.fail === 0,
    summary,
  };
}

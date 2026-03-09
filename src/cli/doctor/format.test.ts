/**
 * Doctor format module unit tests
 * Tests for structured findings serialization and output formatting
 */

import { describe, test, expect } from "vitest";
import { formatDoctorReport, createDoctorReport, printDoctorReport } from "./format";
import type { DoctorFinding } from "./types";

describe("createDoctorReport", () => {
  test("creates report with correct passed status when no failures", () => {
    const findings: DoctorFinding[] = [
      { id: "test:pass", level: "pass", summary: "Test passed" },
      { id: "test:warn", level: "warn", summary: "Test warning" },
    ];
    const report = createDoctorReport(findings);

    expect(report.passed).toBe(true);
    expect(report.findings).toEqual(findings);
    expect(report.summary.pass).toBe(1);
    expect(report.summary.warn).toBe(1);
    expect(report.summary.fail).toBe(0);
  });

  test("creates report with failed status when failures present", () => {
    const findings: DoctorFinding[] = [{ id: "test:fail", level: "fail", summary: "Test failed" }];
    const report = createDoctorReport(findings);

    expect(report.passed).toBe(false);
    expect(report.summary.fail).toBe(1);
  });

  test("handles empty findings array", () => {
    const report = createDoctorReport([]);

    expect(report.passed).toBe(true);
    expect(report.summary.pass).toBe(0);
    expect(report.summary.warn).toBe(0);
    expect(report.summary.fail).toBe(0);
  });

  test("correctly counts all finding levels", () => {
    const findings: DoctorFinding[] = [
      { id: "1", level: "pass", summary: "Pass 1" },
      { id: "2", level: "pass", summary: "Pass 2" },
      { id: "3", level: "warn", summary: "Warn 1" },
      { id: "4", level: "warn", summary: "Warn 2" },
      { id: "5", level: "warn", summary: "Warn 3" },
      { id: "6", level: "fail", summary: "Fail 1" },
    ];
    const report = createDoctorReport(findings);

    expect(report.summary.pass).toBe(2);
    expect(report.summary.warn).toBe(3);
    expect(report.summary.fail).toBe(1);
  });
});

describe("formatDoctorReport", () => {
  test("outputs valid JSON when json option is true", () => {
    const findings: DoctorFinding[] = [{ id: "test:pass", level: "pass", summary: "Test passed" }];
    const report = createDoctorReport(findings);
    const output = formatDoctorReport(report, { json: true });

    // Should be valid JSON
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("passed");
    expect(parsed).toHaveProperty("findings");
    expect(parsed).toHaveProperty("summary");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].id).toBe("test:pass");
  });

  test("includes all finding fields in JSON output", () => {
    const findings: DoctorFinding[] = [
      {
        id: "test:full",
        level: "fail",
        summary: "Full finding summary",
        details: "Detailed explanation",
        fixHint: "How to fix it",
      },
    ];
    const report = createDoctorReport(findings);
    const output = formatDoctorReport(report, { json: true });
    const parsed = JSON.parse(output);

    expect(parsed.findings[0].id).toBe("test:full");
    expect(parsed.findings[0].level).toBe("fail");
    expect(parsed.findings[0].summary).toBe("Full finding summary");
    expect(parsed.findings[0].details).toBe("Detailed explanation");
    expect(parsed.findings[0].fixHint).toBe("How to fix it");
  });

  test("outputs text format by default", () => {
    const findings: DoctorFinding[] = [{ id: "test:pass", level: "pass", summary: "Test passed" }];
    const report = createDoctorReport(findings);
    const output = formatDoctorReport(report, {});

    expect(output).toContain("Config check passed");
  });

  test("outputs failure message when failures present", () => {
    const findings: DoctorFinding[] = [
      { id: "test:fail", level: "fail", summary: "Something failed" },
    ];
    const report = createDoctorReport(findings);
    const output = formatDoctorReport(report, {});

    expect(output).toContain("Config check failed");
    expect(output).toContain("Something failed");
  });

  test("includes details in verbose mode", () => {
    const findings: DoctorFinding[] = [
      {
        id: "test:detail",
        level: "fail",
        summary: "Failed",
        details: "Detailed info",
      },
    ];
    const report = createDoctorReport(findings);
    const output = formatDoctorReport(report, { verbose: true });

    expect(output).toContain("Detailed info");
  });

  test("includes fixHint in verbose mode", () => {
    const findings: DoctorFinding[] = [
      {
        id: "test:fix",
        level: "warn",
        summary: "Warning",
        fixHint: "Run --fix to resolve",
      },
    ];
    const report = createDoctorReport(findings);
    const output = formatDoctorReport(report, { verbose: true });

    expect(output).toContain("Run --fix to resolve");
  });

  test("groups warnings separately", () => {
    const findings: DoctorFinding[] = [
      { id: "test:fail", level: "fail", summary: "Failed" },
      { id: "test:warn", level: "warn", summary: "Warning" },
    ];
    const report = createDoctorReport(findings);
    const output = formatDoctorReport(report, {});

    expect(output).toContain("Failed");
    expect(output).toContain("Warnings:");
    expect(output).toContain("Warning");
  });

  test("shows passed findings in verbose mode", () => {
    const findings: DoctorFinding[] = [{ id: "test:pass", level: "pass", summary: "Passed check" }];
    const report = createDoctorReport(findings);
    const output = formatDoctorReport(report, { verbose: true });

    expect(output).toContain("Passed checks:");
    expect(output).toContain("Passed check");
  });

  test("does not show passed findings in non-verbose mode", () => {
    const findings: DoctorFinding[] = [{ id: "test:pass", level: "pass", summary: "Passed check" }];
    const report = createDoctorReport(findings);
    const output = formatDoctorReport(report, {});

    expect(output).not.toContain("Passed check");
  });

  test("serializes multiple findings correctly", () => {
    const findings: DoctorFinding[] = [
      { id: "config:no-agents", level: "fail", summary: "No agents configured" },
      { id: "config:unknown-model", level: "fail", summary: "Unknown model referenced" },
      { id: "config:heartbeat-disabled", level: "warn", summary: "Heartbeat disabled" },
      { id: "config:provider-api-key", level: "pass", summary: "Provider API key present" },
    ];
    const report = createDoctorReport(findings);
    const output = formatDoctorReport(report, { json: true });
    const parsed = JSON.parse(output);

    expect(parsed.findings).toHaveLength(4);
    expect(parsed.summary.fail).toBe(2);
    expect(parsed.summary.warn).toBe(1);
    expect(parsed.summary.pass).toBe(1);
  });

  test("maintains backward compatibility with text output", () => {
    const findings: DoctorFinding[] = [
      { id: "config:no-agents", level: "fail", summary: "No agents configured" },
    ];
    const report = createDoctorReport(findings);
    const output = formatDoctorReport(report, {});

    // Verify expected output format
    expect(output).toMatch(/^✅|❌/);
    expect(output).toContain("No agents configured");
  });
});

describe("printDoctorReport", () => {
  test("prints JSON to console.log when json option is true", () => {
    const findings: DoctorFinding[] = [{ id: "test:pass", level: "pass", summary: "Test passed" }];
    const report = createDoctorReport(findings);

    // Capture console output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.map(String).join(" "));
    printDoctorReport(report, { json: true });
    console.log = originalLog;

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.passed).toBe(true);
  });

  test("prints failure to console.error", () => {
    const findings: DoctorFinding[] = [{ id: "test:fail", level: "fail", summary: "Failed" }];
    const report = createDoctorReport(findings);

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.map(String).join(" "));

    printDoctorReport(report, {});

    console.error = originalError;
    console.log = originalLog;

    expect(errors.some((e) => e.includes("Failed"))).toBe(true);
  });
});

describe("structured findings serialization", () => {
  test("findings with all optional fields serialize correctly", () => {
    const finding: DoctorFinding = {
      id: "test:complete",
      level: "fail",
      summary: "Complete finding",
      details: "This is a detailed explanation",
      fixHint: "Do this to fix",
    };
    const report = createDoctorReport([finding]);
    const output = formatDoctorReport(report, { json: true });
    const parsed = JSON.parse(output);

    expect(parsed.findings[0]).toEqual(finding);
  });

  test("findings with only required fields serialize correctly", () => {
    const finding: DoctorFinding = {
      id: "test:minimal",
      level: "pass",
      summary: "Minimal finding",
    };
    const report = createDoctorReport([finding]);
    const output = formatDoctorReport(report, { json: true });
    const parsed = JSON.parse(output);

    expect(parsed.findings[0]).toEqual(finding);
    expect(parsed.findings[0].details).toBeUndefined();
    expect(parsed.findings[0].fixHint).toBeUndefined();
  });

  test("report summary serializes correctly", () => {
    const findings: DoctorFinding[] = [
      { id: "1", level: "pass", summary: "Pass" },
      { id: "2", level: "warn", summary: "Warn" },
      { id: "3", level: "fail", summary: "Fail" },
    ];
    const report = createDoctorReport(findings);
    const output = formatDoctorReport(report, { json: true });
    const parsed = JSON.parse(output);

    expect(parsed.summary).toEqual({
      pass: 1,
      warn: 1,
      fail: 1,
    });
  });

  test("JSON output is parseable after multiple calls", () => {
    const report1 = createDoctorReport([{ id: "1", level: "pass", summary: "Test 1" }]);
    const report2 = createDoctorReport([{ id: "2", level: "fail", summary: "Test 2" }]);

    const output1 = formatDoctorReport(report1, { json: true });
    const output2 = formatDoctorReport(report2, { json: true });

    const parsed1 = JSON.parse(output1);
    const parsed2 = JSON.parse(output2);

    expect(parsed1.passed).toBe(true);
    expect(parsed2.passed).toBe(false);
  });
});

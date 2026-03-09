import fs from "node:fs";
import { promises as fsp } from "node:fs";
import JSON5 from "json5";
import {
  applyConfigOps,
  deleteConfigValue,
  isConfigConflictError,
  loadConfig,
  patchConfig,
  readConfigSnapshot,
  setConfigValue,
  writeConfigRawAtomic,
} from "../../config";
import { bootstrapSandboxes } from "../../runtime/sandbox/bootstrap";
import { runConfigChecks, createDoctorReport, printDoctorReport } from "../doctor";

export async function validateConfig(configPath?: string) {
  const result = loadConfig(configPath);
  if (result.success) {
    console.log("✅ Config check passed. The config file is valid.");
    return;
  }
  console.error("❌ Config check failed. Invalid config file:");
  for (const error of result.errors ?? []) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

function parseJsonValue(raw: string): unknown {
  try {
    return JSON5.parse(raw);
  } catch {
    return raw;
  }
}

function parsePatchValue(raw: string): Record<string, unknown> {
  const parsed = parseJsonValue(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Patch must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseOperations(raw: string) {
  const parsed = parseJsonValue(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Apply operations must be a JSON array");
  }
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("op" in item)) {
      throw new Error("Each operation must be an object with an op field");
    }
    const op = (item as { op?: unknown }).op;
    if (op !== "set" && op !== "delete" && op !== "patch") {
      throw new Error(`Unsupported op: ${String(op)}`);
    }
  }
  return parsed as Array<
    | { op: "set"; path: string; value: unknown }
    | { op: "delete"; path: string }
    | { op: "patch"; value: Record<string, unknown> }
  >;
}

function readArgOrFile(
  input: string | undefined,
  filePath: string | undefined,
  kind: string,
): string {
  if (filePath) {
    return fs.readFileSync(filePath, "utf-8");
  }
  if (!input) {
    throw new Error(`${kind} is required (argument or --file)`);
  }
  return input;
}

function printSnapshot(snapshot: ReturnType<typeof readConfigSnapshot>, asJson: boolean): void {
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          path: snapshot.path,
          exists: snapshot.exists,
          rawHash: snapshot.rawHash,
          effectiveHash: snapshot.effectiveHash,
          valid: snapshot.load.success,
          errors: snapshot.load.errors ?? [],
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`path: ${snapshot.path}`);
  console.log(`exists: ${snapshot.exists}`);
  console.log(`rawHash: ${snapshot.rawHash}`);
  console.log(`effectiveHash: ${snapshot.effectiveHash ?? "<invalid>"}`);
  console.log(`valid: ${snapshot.load.success}`);
  if (!snapshot.load.success) {
    for (const error of snapshot.load.errors ?? []) {
      console.log(`error: ${error}`);
    }
  }
}

function handleMutationError(error: unknown): never {
  if (isConfigConflictError(error)) {
    console.error(`❌ Config write rejected: conflict detected (${error.message})`);
    process.exit(2);
  }
  console.error(
    `❌ Config write failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

function printMutationSuccess(label: string, rawHash: string): void {
  console.log(`✅ ${label}`);
  console.log(`rawHash: ${rawHash}`);
}

async function rollbackConfig(
  before: ReturnType<typeof readConfigSnapshot>,
  after: ReturnType<typeof readConfigSnapshot>,
): Promise<void> {
  if (before.exists) {
    await writeConfigRawAtomic(before.path, before.raw ?? "{}\n", {
      expectedRawHash: after.rawHash,
    });
    return;
  }
  const current = readConfigSnapshot(before.path);
  if (current.rawHash !== after.rawHash) {
    throw new Error("Config changed during rollback; manual intervention required");
  }
  if (current.exists) {
    await fsp.unlink(before.path);
  }
}

async function postMutationValidateOrRollback(
  mutationLabel: string,
  before: ReturnType<typeof readConfigSnapshot>,
  after: ReturnType<typeof readConfigSnapshot>,
): Promise<void> {
  if (!after.load.success || !after.load.config) {
    await rollbackConfig(before, after);
    console.error(
      `❌ ${mutationLabel} rejected: the resulting config could not be loaded. Changes were rolled back.`,
    );
    for (const error of after.load.errors ?? []) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  const findings = await runConfigChecks(after.load.config, {
    config: after.load.config,
    fix: false,
  });
  const report = createDoctorReport(findings);
  if (report.summary.fail > 0) {
    await rollbackConfig(before, after);
    console.error(`❌ ${mutationLabel} rejected by config checks. Changes were rolled back.`);
    printDoctorReport(report, {});
    process.exit(1);
  }
  if (report.summary.warn > 0) {
    printDoctorReport(report, {});
  }
}

export async function snapshotConfig(options: { config?: string; json?: boolean }) {
  const snapshot = readConfigSnapshot(options.config);
  printSnapshot(snapshot, Boolean(options.json));
  if (!snapshot.load.success) {
    process.exit(1);
  }
}

export async function setConfigEntry(
  entryPath: string,
  rawValue: string,
  options: { config?: string; json?: boolean; ifHash?: string },
) {
  try {
    const value = options.json ? JSON5.parse(rawValue) : parseJsonValue(rawValue);
    const result = await setConfigValue({
      path: entryPath,
      value,
      options: {
        configPath: options.config,
        expectedRawHash: options.ifHash,
      },
    });
    await postMutationValidateOrRollback("Configuration update", result.before, result.after);

    printMutationSuccess("Config updated.", result.after.rawHash);
  } catch (error) {
    handleMutationError(error);
  }
}

export async function unsetConfigEntry(
  entryPath: string,
  options: { config?: string; ifHash?: string },
) {
  try {
    const result = await deleteConfigValue({
      path: entryPath,
      options: {
        configPath: options.config,
        expectedRawHash: options.ifHash,
      },
    });
    await postMutationValidateOrRollback("Configuration update", result.before, result.after);
    printMutationSuccess("Config updated.", result.after.rawHash);
  } catch (error) {
    handleMutationError(error);
  }
}

export async function patchConfigEntry(
  rawPatch: string | undefined,
  options: { config?: string; ifHash?: string; file?: string },
) {
  try {
    const content = readArgOrFile(rawPatch, options.file, "Patch payload");
    const patch = parsePatchValue(content);
    const result = await patchConfig({
      patch,
      options: {
        configPath: options.config,
        expectedRawHash: options.ifHash,
      },
    });
    await postMutationValidateOrRollback("Configuration patch", result.before, result.after);
    printMutationSuccess("Config patched.", result.after.rawHash);
  } catch (error) {
    handleMutationError(error);
  }
}

export async function applyConfigOperations(
  rawOperations: string | undefined,
  options: { config?: string; ifHash?: string; file?: string },
) {
  try {
    const content = readArgOrFile(rawOperations, options.file, "Operations payload");
    const operations = parseOperations(content);
    const result = await applyConfigOps({
      operations,
      options: {
        configPath: options.config,
        expectedRawHash: options.ifHash,
      },
    });
    await postMutationValidateOrRollback("Configuration apply", result.before, result.after);
    printMutationSuccess("Config applied.", result.after.rawHash);
  } catch (error) {
    handleMutationError(error);
  }
}

export async function doctorConfig(
  configPath?: string,
  options: { fix?: boolean; json?: boolean; verbose?: boolean } = {},
) {
  const result = loadConfig(configPath);
  if (!result.success || !result.config) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            passed: false,
            findings: [
              {
                id: "config:load-failed",
                level: "fail",
                summary: "Failed to load config file",
                details: result.errors?.join(", "),
              },
            ],
            summary: { pass: 0, warn: 0, fail: 1 },
          },
          null,
          2,
        ),
      );
    } else {
      console.error("❌ Config check failed. Invalid config file:");
      for (const error of result.errors ?? []) {
        console.error(`- ${error}`);
      }
    }
    process.exit(1);
  }

  const config = result.config;

  // Run config checks using the shared framework
  const findings = await runConfigChecks(config, { config, fix: Boolean(options.fix) });
  let report = createDoctorReport(findings);

  // Handle --fix option
  if (options.fix) {
    const hasBlockingIssues = report.summary.fail > 0;
    if (hasBlockingIssues) {
      report.findings.push({
        id: "sandbox:skipped",
        level: "warn",
        summary: "Sandbox bootstrap skipped because blocking config issues exist.",
      });
    } else {
      const bootstrap = await bootstrapSandboxes(config, { fix: true });
      // Only print bootstrap actions to stdout in non-JSON mode
      // In JSON mode, we suppress these to keep stdout valid JSON
      if (!options.json) {
        for (const action of bootstrap.actions) {
          console.log(`🔧 [${action.agentId}] ${action.message}`);
        }
      }
      for (const issue of bootstrap.issues) {
        const finding: {
          id: string;
          level: "fail" | "warn";
          summary: string;
          details?: string;
          fixHint?: string;
        } = {
          id: `sandbox:${issue.agentId}`,
          level: issue.level === "error" ? "fail" : "warn",
          summary: `[${issue.agentId}] ${issue.message}`,
        };
        if (issue.hints.length > 0) {
          finding.details = issue.hints.join("; ");
        }
        report.findings.push(finding);
      }
      // Recalculate report after sandbox changes
      report = createDoctorReport(report.findings);
    }
  }

  // Output the report
  printDoctorReport(report, { json: options.json, verbose: options.verbose });

  if (report.summary.fail > 0) {
    process.exit(1);
  }
}

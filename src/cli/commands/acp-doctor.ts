import { loadConfig } from "../../config";
import { runAcpChecks, createDoctorReport, printDoctorReport } from "../doctor";

export type AcpDoctorOptions = {
  config?: string;
  json?: boolean;
  verbose?: boolean;
};

/**
 * Run ACP-specific doctor checks.
 * Does not start any long-running ACP runtime processes.
 */
export async function acpDoctor(options: AcpDoctorOptions): Promise<void> {
  const result = loadConfig(options.config);

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
      console.error("❌ ACP doctor failed: could not load config file:");
      for (const error of result.errors ?? []) {
        console.error(`- ${error}`);
      }
    }
    process.exit(1);
  }

  const config = result.config;
  const findings = await runAcpChecks(config, { config, fix: false });
  const report = createDoctorReport(findings);

  printDoctorReport(report, { json: options.json, verbose: options.verbose });

  if (report.summary.fail > 0) {
    process.exit(1);
  }
}

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const SERVICE_LABEL = "mozi-runtime";
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);

export interface LaunchdServiceConfig {
  command: string;
  args: string[];
  workDir: string;
  logFile: string;
  env?: Record<string, string>;
}

export async function installLaunchdService(config: LaunchdServiceConfig): Promise<void> {
  ensureLaunchdSupported();
  await fs.mkdir(path.dirname(PLIST_PATH), { recursive: true });
  await fs.mkdir(path.dirname(config.logFile), { recursive: true });

  const plist = buildLaunchdPlist(config);
  await fs.writeFile(PLIST_PATH, plist, "utf-8");

  const domain = launchdDomain();
  await launchctl(["bootout", domain, PLIST_PATH]).catch(() => {});
  await launchctl(["bootstrap", domain, PLIST_PATH]);
  await launchctl(["enable", `${domain}/${SERVICE_LABEL}`]).catch(() => {});
  await launchctl(["kickstart", "-k", `${domain}/${SERVICE_LABEL}`]);
}

export async function uninstallLaunchdService(): Promise<void> {
  ensureLaunchdSupported();
  const domain = launchdDomain();
  await launchctl(["bootout", domain, PLIST_PATH]).catch(() => {});
  await launchctl(["disable", `${domain}/${SERVICE_LABEL}`]).catch(() => {});
  try {
    await fs.unlink(PLIST_PATH);
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "ENOENT") {
      throw err;
    }
  }
}

export async function isLaunchdServiceInstalled(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    await fs.access(PLIST_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function isLaunchdServiceRunning(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  const domain = launchdDomain();
  try {
    const { stdout } = await launchctl(["print", `${domain}/${SERVICE_LABEL}`]);
    return /state\s*=\s*running/i.test(stdout);
  } catch {
    return false;
  }
}

function ensureLaunchdSupported() {
  if (process.platform !== "darwin") {
    throw new Error("launchd service management is supported only on macOS.");
  }
}

function launchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (typeof uid !== "number") {
    throw new Error("Unable to resolve current uid for launchd domain.");
  }
  return `gui/${uid}`;
}

async function launchctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await exec("launchctl", args);
}

function buildLaunchdPlist(config: LaunchdServiceConfig): string {
  const args = [config.command, ...config.args].map(
    (value) => `<string>${xmlEscape(value)}</string>`,
  );
  const envEntries = Object.entries(config.env ?? {})
    .map(
      ([key, value]) =>
        `\n    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`,
    )
    .join("");

  const envBlock = envEntries
    ? `\n  <key>EnvironmentVariables</key>\n  <dict>${envEntries}\n  </dict>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    ${args.join("\n    ")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(config.workDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(config.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(config.logFile)}</string>${envBlock}
</dict>
</plist>
`;
}

function xmlEscape(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

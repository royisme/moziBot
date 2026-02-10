import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const SERVICE_NAME = "mozi-runtime";
const UNIT_PATH = path.join(os.homedir(), ".config/systemd/user", `${SERVICE_NAME}.service`);

export interface ServiceConfig {
  command: string;
  args: string[];
  workDir: string;
  env?: Record<string, string>;
}

export async function installSystemdService(config: ServiceConfig): Promise<void> {
  ensureSystemdSupported();
  const unit = buildSystemdUnit(config);
  await fs.mkdir(path.dirname(UNIT_PATH), { recursive: true });
  await fs.writeFile(UNIT_PATH, unit);
  await exec("systemctl", ["--user", "daemon-reload"]);
  await exec("systemctl", ["--user", "enable", SERVICE_NAME]);
  await exec("systemctl", ["--user", "restart", SERVICE_NAME]);
}

export async function uninstallSystemdService(): Promise<void> {
  ensureSystemdSupported();
  await exec("systemctl", ["--user", "stop", SERVICE_NAME]).catch(() => {});
  await exec("systemctl", ["--user", "disable", SERVICE_NAME]).catch(() => {});
  try {
    await fs.unlink(UNIT_PATH);
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "ENOENT") {
      throw err;
    }
  }
  await exec("systemctl", ["--user", "daemon-reload"]);
}

export async function isServiceInstalled(): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    await fs.access(UNIT_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function isServiceRunning(): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const { stdout } = await exec("systemctl", ["--user", "is-active", SERVICE_NAME]);
    return stdout.trim() === "active";
  } catch {
    return false;
  }
}

function buildSystemdUnit(config: ServiceConfig): string {
  const execStart = [config.command, ...config.args].map((part) => quoteSystemdArg(part)).join(" ");
  const envLines = Object.entries(config.env ?? {})
    .map(([key, value]) => `Environment=${key}=${quoteEnvValue(value)}`)
    .join("\n");

  return `[Unit]
Description=Mozi Runtime
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${config.workDir}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
${envLines}

[Install]
WantedBy=default.target
`;
}

function ensureSystemdSupported() {
  if (process.platform !== "linux") {
    throw new Error("Systemd service management is supported only on Linux.");
  }
}

function quoteSystemdArg(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function quoteEnvValue(value: string): string {
  return value.replace(/\n/g, " ");
}

import {
  installLaunchdService,
  isLaunchdServiceInstalled,
  isLaunchdServiceRunning,
  uninstallLaunchdService,
} from "./launchd";
import {
  installSystemdService,
  isServiceInstalled as isSystemdServiceInstalled,
  isServiceRunning as isSystemdServiceRunning,
  uninstallSystemdService,
} from "./systemd";

export interface RuntimeServiceConfig {
  command: string;
  args: string[];
  workDir: string;
  logFile: string;
  env?: Record<string, string>;
}

export type ServiceProvider = "systemd" | "launchd" | "none";

export function detectServiceProvider(): ServiceProvider {
  if (process.platform === "linux") {
    return "systemd";
  }
  if (process.platform === "darwin") {
    return "launchd";
  }
  return "none";
}

export async function installRuntimeService(config: RuntimeServiceConfig): Promise<void> {
  const provider = detectServiceProvider();
  if (provider === "systemd") {
    await installSystemdService({
      command: config.command,
      args: config.args,
      workDir: config.workDir,
      env: config.env,
    });
    return;
  }

  if (provider === "launchd") {
    await installLaunchdService(config);
    return;
  }

  throw new Error(`Runtime service install is not supported on platform: ${process.platform}`);
}

export async function uninstallRuntimeService(): Promise<void> {
  const provider = detectServiceProvider();
  if (provider === "systemd") {
    await uninstallSystemdService();
    return;
  }
  if (provider === "launchd") {
    await uninstallLaunchdService();
    return;
  }
  throw new Error(`Runtime service uninstall is not supported on platform: ${process.platform}`);
}

export async function isRuntimeServiceInstalled(): Promise<boolean> {
  const provider = detectServiceProvider();
  if (provider === "systemd") {
    return await isSystemdServiceInstalled();
  }
  if (provider === "launchd") {
    return await isLaunchdServiceInstalled();
  }
  return false;
}

export async function isRuntimeServiceRunning(): Promise<boolean> {
  const provider = detectServiceProvider();
  if (provider === "systemd") {
    return await isSystemdServiceRunning();
  }
  if (provider === "launchd") {
    return await isLaunchdServiceRunning();
  }
  return false;
}

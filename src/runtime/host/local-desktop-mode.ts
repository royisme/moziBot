import type { MoziConfig } from "../../config";

export type LocalDesktopWidgetMode = "auto" | "on" | "off";
type LocalDesktopModeSource = "env" | "config" | "legacy-enabled" | "default";

type DesktopEnvironmentProbe = {
  isDesktop: boolean;
  reason: string;
};

export type LocalDesktopDecision = {
  mode: LocalDesktopWidgetMode;
  source: LocalDesktopModeSource;
  enabled: boolean;
  reason: string;
};

function normalizeMode(raw: unknown): LocalDesktopWidgetMode | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "auto" || value === "on" || value === "off") {
    return value;
  }
  return null;
}

function isTruthy(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function probeDesktopEnvironment(params?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): DesktopEnvironmentProbe {
  const env = params?.env ?? process.env;
  const platform = params?.platform ?? process.platform;

  if (isTruthy(env.CI)) {
    return { isDesktop: false, reason: "CI environment detected" };
  }
  if (isTruthy(env.MOZI_WIDGET_HEADLESS)) {
    return { isDesktop: false, reason: "MOZI_WIDGET_HEADLESS override" };
  }
  if (platform === "linux") {
    if (env.WAYLAND_DISPLAY || env.DISPLAY) {
      return { isDesktop: true, reason: "Linux display session detected" };
    }
    return { isDesktop: false, reason: "No DISPLAY/WAYLAND_DISPLAY in Linux environment" };
  }
  if (platform === "darwin") {
    return { isDesktop: true, reason: "macOS environment detected" };
  }
  if (platform === "win32") {
    return { isDesktop: true, reason: "Windows environment detected" };
  }
  return { isDesktop: false, reason: `Unsupported platform for desktop widget: ${platform}` };
}

export function resolveLocalDesktopDecision(
  config: MoziConfig,
  params?: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  },
): LocalDesktopDecision {
  const env = params?.env ?? process.env;
  const localDesktop = config.channels?.localDesktop;

  const envMode = normalizeMode(env.MOZI_WIDGET_MODE);
  if (envMode) {
    if (envMode === "off") {
      return { mode: envMode, source: "env", enabled: false, reason: "Disabled by MOZI_WIDGET_MODE" };
    }
    if (envMode === "on") {
      return { mode: envMode, source: "env", enabled: true, reason: "Forced on by MOZI_WIDGET_MODE" };
    }
    const probe = probeDesktopEnvironment(params);
    return {
      mode: envMode,
      source: "env",
      enabled: probe.isDesktop,
      reason: probe.reason,
    };
  }

  const configMode = normalizeMode(localDesktop?.widget?.mode);
  if (configMode) {
    if (configMode === "off") {
      return { mode: configMode, source: "config", enabled: false, reason: "Disabled by config" };
    }
    if (configMode === "on") {
      return { mode: configMode, source: "config", enabled: true, reason: "Forced on by config" };
    }
    const probe = probeDesktopEnvironment(params);
    return {
      mode: configMode,
      source: "config",
      enabled: probe.isDesktop,
      reason: probe.reason,
    };
  }

  if (localDesktop?.enabled === false) {
    return {
      mode: "off",
      source: "legacy-enabled",
      enabled: false,
      reason: "Disabled by legacy channels.localDesktop.enabled=false",
    };
  }
  if (localDesktop?.enabled === true) {
    return {
      mode: "on",
      source: "legacy-enabled",
      enabled: true,
      reason: "Enabled by legacy channels.localDesktop.enabled=true",
    };
  }

  const probe = probeDesktopEnvironment(params);
  return {
    mode: "auto",
    source: "default",
    enabled: probe.isDesktop,
    reason: probe.reason,
  };
}

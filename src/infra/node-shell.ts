/**
 * Build a shell command argv array from a command string.
 * Aligns with openclaw's buildNodeShellCommand convention.
 */
export function buildShellCommand(command: string, platform?: string | null): string[] {
  const normalized = String(platform ?? "").trim().toLowerCase();
  if (normalized.startsWith("win")) {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  return ["/bin/sh", "-lc", command];
}

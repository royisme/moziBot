import fs from "node:fs";
import path from "node:path";

export function getShellConfig(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      shell: resolvePowerShellPath(),
      args: ["-NoProfile", "-NonInteractive", "-Command"],
    };
  }

  const envShell = process.env.SHELL?.trim();
  const shellName = envShell ? path.basename(envShell) : "";
  // Fish rejects common bashisms, prefer bash when detected.
  if (shellName === "fish") {
    const bash = resolveShellFromPath("bash");
    if (bash) return { shell: bash, args: ["-c"] };
    const sh = resolveShellFromPath("sh");
    if (sh) return { shell: sh, args: ["-c"] };
  }
  const shell = envShell && envShell.length > 0 ? envShell : "sh";
  return { shell, args: ["-c"] };
}

function resolvePowerShellPath(): string {
  const programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES || "C:\\Program Files";
  const pwsh7 = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
  if (fs.existsSync(pwsh7)) return pwsh7;

  const pwshInPath = resolveShellFromPath("pwsh");
  if (pwshInPath) return pwshInPath;

  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (systemRoot) {
    const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "powershell.exe";
}

function resolveShellFromPath(name: string): string | undefined {
  const envPath = process.env.PATH ?? "";
  if (!envPath) return undefined;
  for (const entry of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found or not executable
    }
  }
  return undefined;
}

export function sanitizeBinaryOutput(text: string): string {
  const scrubbed = text.replace(/[\p{Format}\p{Surrogate}]/gu, "");
  if (!scrubbed) return scrubbed;
  const chunks: string[] = [];
  for (const char of scrubbed) {
    const code = char.codePointAt(0);
    if (code == null) continue;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      chunks.push(char);
      continue;
    }
    if (code < 0x20) continue;
    chunks.push(char);
  }
  return chunks.join("");
}

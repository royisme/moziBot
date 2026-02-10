import { input } from "@inquirer/prompts";
import fs from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { resolveConfigPath } from "../../config/loader";

const PROVIDER_ENV_MAP: Record<string, string> = {
  tavily: "TAVILY_API_KEY",
  brave: "BRAVE_API_KEY",
};

function resolveTargetEnvVar(target: string): string {
  const normalized = target.trim().toLowerCase();
  if (PROVIDER_ENV_MAP[normalized]) {
    return PROVIDER_ENV_MAP[normalized];
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(target.trim())) {
    return target.trim();
  }
  throw new Error(
    `Unknown target "${target}". Use one of: tavily, brave, or an ENV var like TAVILY_API_KEY.`,
  );
}

function envFilePath(configPath?: string): string {
  if (configPath) {
    return path.join(path.dirname(path.resolve(configPath)), ".env");
  }
  return path.join(path.dirname(resolveConfigPath()), ".env");
}

function parseEnvFile(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = line.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) {
      map.set(key, value);
    }
  }
  return map;
}

async function upsertEnvValue(filePath: string, key: string, value: string): Promise<void> {
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch {
    // file missing is fine
  }

  const lines = existing
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  const newLine = `${key}=${value}`;
  if (index >= 0) {
    lines[index] = newLine;
  } else {
    lines.push(newLine);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, { mode: 0o600 });
}

async function removeEnvValue(filePath: string, key: string): Promise<boolean> {
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch {
    return false;
  }
  const lines = existing
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
  const next = lines.filter((line) => !line.startsWith(`${key}=`));
  if (next.length === lines.length) {
    return false;
  }
  await fs.writeFile(filePath, `${next.join("\n")}${next.length > 0 ? "\n" : ""}`, { mode: 0o600 });
  return true;
}

function renderStatus(fileValues: Map<string, string>, envName: string): string {
  const inProcess = Boolean(process.env[envName]);
  const inFile = fileValues.has(envName);
  if (inProcess && inFile) {
    return pc.green("set (env + .env)");
  }
  if (inProcess) {
    return pc.green("set (env)");
  }
  if (inFile) {
    return pc.green("set (.env)");
  }
  return pc.red("not set");
}

export async function authSet(
  target: string,
  options: { config?: string; value?: string },
): Promise<void> {
  const envName = resolveTargetEnvVar(target);
  const secret =
    options.value ??
    (await input({
      message: `Enter value for ${envName}:`,
      validate: (v) => (v.trim().length > 0 ? true : "Value is required"),
    }));

  if (secret.includes("\n") || secret.includes("\r")) {
    console.error(pc.red("Value must be a single line."));
    process.exit(1);
  }

  const filePath = envFilePath(options.config);
  await upsertEnvValue(filePath, envName, secret.trim());

  console.log(pc.green(`Saved ${envName} to ${filePath}`));
  console.log(pc.dim("Restart mozi runtime if it is already running."));
}

export async function authList(options: { config?: string }): Promise<void> {
  const filePath = envFilePath(options.config);
  let fileValues = new Map<string, string>();
  try {
    const content = await fs.readFile(filePath, "utf-8");
    fileValues = parseEnvFile(content);
  } catch {
    // ignore if missing
  }

  console.log(pc.bold("Auth keys"));
  console.log(
    `  tavily (${pc.cyan("TAVILY_API_KEY")}): ${renderStatus(fileValues, "TAVILY_API_KEY")}`,
  );
  console.log(
    `  brave  (${pc.cyan("BRAVE_API_KEY")}): ${renderStatus(fileValues, "BRAVE_API_KEY")}`,
  );
  console.log("");
  console.log(pc.dim(`.env path: ${filePath}`));
}

export async function authRemove(target: string, options: { config?: string }): Promise<void> {
  const envName = resolveTargetEnvVar(target);
  const filePath = envFilePath(options.config);
  const removed = await removeEnvValue(filePath, envName);
  if (!removed) {
    console.log(pc.yellow(`${envName} not found in ${filePath}`));
    return;
  }
  console.log(pc.green(`Removed ${envName} from ${filePath}`));
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";

const DEFAULT_BASE_DIR = path.join(os.homedir(), ".mozi");
const DEFAULT_HOME = path.join(DEFAULT_BASE_DIR, "agents", "main", "home");
const DEFAULT_WORKSPACE = path.join(DEFAULT_BASE_DIR, "agents", "main", "workspace");

interface HealthCheck {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
}

interface AgentConfig {
  main?: boolean;
  home?: string;
  workspace?: string;
}

interface ParsedConfig {
  agents?: {
    defaults?: unknown;
    [key: string]: unknown;
  };
}

async function loadConfig(): Promise<{ configPath: string; config: ParsedConfig | null }> {
  const configPath = path.join(DEFAULT_BASE_DIR, "config.jsonc");
  try {
    const content = await fs.readFile(configPath, "utf-8");
    // Strip JSONC comments
    const stripped = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    const config = JSON.parse(stripped) as ParsedConfig;
    return { configPath, config };
  } catch {
    return { configPath, config: null };
  }
}

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

function resolveDefaultAgentConfig(config: ParsedConfig | null): AgentConfig | undefined {
  if (!config?.agents || typeof config.agents !== "object") {
    return undefined;
  }

  const entries = Object.entries(config.agents)
    .filter(([id]) => id !== "defaults")
    .map(([, entry]) => entry)
    .filter(
      (entry): entry is AgentConfig =>
        !!entry && typeof entry === "object" && !Array.isArray(entry),
    );

  const explicitMain = entries.find((entry) => entry.main === true);
  return explicitMain ?? entries[0];
}

async function checkConfig(): Promise<HealthCheck> {
  const { configPath, config } = await loadConfig();
  if (config === null) {
    try {
      await fs.access(configPath);
      return {
        name: "Configuration",
        status: "error",
        message: "Invalid JSON format",
      };
    } catch {
      return {
        name: "Configuration",
        status: "error",
        message: `Not found. Run ${pc.cyan("mozi init")} to create.`,
      };
    }
  }
  return { name: "Configuration", status: "ok", message: configPath };
}

async function checkHome(): Promise<HealthCheck> {
  const { config } = await loadConfig();
  let homePath = DEFAULT_HOME;

  const defaultAgent = resolveDefaultAgentConfig(config);
  if (defaultAgent?.home) {
    homePath = resolvePath(defaultAgent.home);
  }

  try {
    const stat = await fs.stat(homePath);
    if (!stat.isDirectory()) {
      return { name: "Agent Home", status: "error", message: "Not a directory" };
    }

    // Check for key files
    const requiredFiles = ["AGENTS.md", "SOUL.md", "IDENTITY.md"];
    const missing: string[] = [];
    for (const file of requiredFiles) {
      try {
        await fs.access(path.join(homePath, file));
      } catch {
        missing.push(file);
      }
    }

    if (missing.length > 0) {
      return {
        name: "Agent Home",
        status: "warn",
        message: `Missing: ${missing.join(", ")}. Run ${pc.cyan("mozi setup")}`,
      };
    }

    return { name: "Agent Home", status: "ok", message: homePath };
  } catch {
    return {
      name: "Agent Home",
      status: "error",
      message: `Not found. Run ${pc.cyan("mozi init")} to create.`,
    };
  }
}

async function checkWorkspace(): Promise<HealthCheck> {
  const { config } = await loadConfig();
  let workspacePath = DEFAULT_WORKSPACE;

  const defaultAgent = resolveDefaultAgentConfig(config);
  if (defaultAgent?.workspace) {
    workspacePath = resolvePath(defaultAgent.workspace);
  }

  try {
    const stat = await fs.stat(workspacePath);
    if (!stat.isDirectory()) {
      return { name: "Workspace", status: "error", message: "Not a directory" };
    }

    return { name: "Workspace", status: "ok", message: workspacePath };
  } catch {
    return {
      name: "Workspace",
      status: "warn",
      message: `Not found (${workspacePath}). Will be created on first run.`,
    };
  }
}

async function checkEnv(): Promise<HealthCheck> {
  const envPath = path.join(DEFAULT_BASE_DIR, ".env");
  try {
    await fs.access(envPath);
    return { name: "Environment", status: "ok", message: envPath };
  } catch {
    // Check if any API key env var is set
    const apiKeys = [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "TAVILY_API_KEY",
      "BRAVE_API_KEY",
    ];
    const found = apiKeys.filter((k) => process.env[k]);
    if (found.length > 0) {
      return {
        name: "Environment",
        status: "ok",
        message: `Using env: ${found.join(", ")}`,
      };
    }
    return {
      name: "Environment",
      status: "warn",
      message: "No API keys found. Set via env, mozi init, or mozi auth set <provider>.",
    };
  }
}

async function checkNode(): Promise<HealthCheck> {
  const version = process.versions.node;
  const major = Number.parseInt(version.split(".")[0], 10);
  if (major >= 22) {
    return { name: "Node.js", status: "ok", message: `v${version}` };
  }
  if (major >= 20) {
    return { name: "Node.js", status: "warn", message: `v${version} (22+ recommended)` };
  }
  return { name: "Node.js", status: "error", message: `v${version} (22+ required)` };
}

function formatStatus(status: HealthCheck["status"]): string {
  switch (status) {
    case "ok":
      return pc.green("✓");
    case "warn":
      return pc.yellow("⚠");
    case "error":
      return pc.red("✗");
  }
}

export async function runHealth() {
  console.log(pc.bold("\n🏥 Mozi Health Check\n"));

  const checks = await Promise.all([
    checkNode(),
    checkConfig(),
    checkHome(),
    checkWorkspace(),
    checkEnv(),
  ]);

  let hasErrors = false;
  let hasWarnings = false;

  for (const check of checks) {
    const icon = formatStatus(check.status);
    console.log(`  ${icon} ${pc.bold(check.name)}: ${check.message}`);
    if (check.status === "error") {
      hasErrors = true;
    }
    if (check.status === "warn") {
      hasWarnings = true;
    }
  }

  console.log();

  if (hasErrors) {
    console.log(pc.red("Some checks failed. Please fix the issues above."));
    process.exitCode = 1;
  } else if (hasWarnings) {
    console.log(pc.yellow("Some warnings detected. Consider addressing them."));
  } else {
    console.log(pc.green("All checks passed! ✨"));
  }

  console.log();
}

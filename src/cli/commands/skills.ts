import chalk from "chalk";
import { buildSkillStatusEntries, type SkillStatusEntry } from "../../agents/skills/status";
import type { MoziConfig } from "../../config";
import { loadConfig } from "../../config/loader";
import { initExtensionsAsync, loadExtensions } from "../../extensions";
import { resolveWorkspaceDir, type AgentEntry } from "../../runtime/agent-manager/config-resolver";
import { createSkillLoaderForContext } from "../../runtime/agent-manager/lifecycle";

export type SkillsListOptions = {
  config?: string;
  json?: boolean;
  verbose?: boolean;
  status?: boolean;
};

type SkillSummary = {
  name: string;
  description?: string;
  filePath: string;
  source?: string;
};

type SkillsReport = {
  skillDirs: string[];
  skills: SkillSummary[];
  status?: SkillStatusEntry[];
};

function loadConfigOrExit(configPath?: string): MoziConfig {
  const configResult = loadConfig(configPath);
  if (!configResult.success || !configResult.config) {
    console.error(chalk.red("Failed to load configuration:"));
    for (const err of configResult.errors ?? []) {
      console.error(`  ${err}`);
    }
    process.exit(1);
  }
  return configResult.config;
}

function resolveDefaultAgentId(config: MoziConfig): string {
  let defaultAgentId = "mozi";
  if (config.agents) {
    const agentIds = Object.keys(config.agents);
    const mainAgent = agentIds.find((id) => {
      const agent = config.agents?.[id];
      return agent && typeof agent === "object" && "main" in agent && agent.main === true;
    });
    if (mainAgent) {
      defaultAgentId = mainAgent;
    } else if (agentIds.length > 0) {
      const nonDefault = agentIds.find((id) => id !== "defaults");
      if (nonDefault) {
        defaultAgentId = nonDefault;
      }
    }
  }
  return defaultAgentId;
}

export async function buildSkillsReport(options?: {
  configPath?: string;
  includeStatus?: boolean;
}): Promise<SkillsReport> {
  const config = loadConfigOrExit(options?.configPath);
  const registry = loadExtensions(config.extensions);
  await initExtensionsAsync(config.extensions, registry);

  const agentId = resolveDefaultAgentId(config);
  const entry = (config.agents?.[agentId] as AgentEntry | undefined) ?? undefined;
  const workspaceDir = resolveWorkspaceDir(config, agentId, entry);
  const loader = createSkillLoaderForContext(config, registry, { workspaceDir });
  await loader.loadAll();

  const loadedSkills = loader.list();
  const skills: SkillSummary[] = loadedSkills.map((skill) => ({
    name: skill.name,
    description: skill.description?.trim() || undefined,
    filePath: skill.filePath,
    source: (skill as { source?: string }).source,
  }));

  const status = options?.includeStatus
    ? await buildSkillStatusEntries({ skills: loadedSkills, config })
    : undefined;

  return {
    skillDirs: loader.listDirs(),
    skills,
    status,
  };
}

export async function listSkills(options: SkillsListOptions): Promise<void> {
  const report = await buildSkillsReport({
    configPath: options.config,
    includeStatus: options.status,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(chalk.bold("Skills"));
  console.log("");

  if (report.skillDirs.length === 0) {
    console.log("No skill directories configured.");
    console.log(chalk.gray('Hint: set "skills.dirs" or "paths.skills" in config.'));
    return;
  }

  console.log(chalk.bold("Skill directories:"));
  for (const dir of report.skillDirs) {
    console.log(`  - ${dir}`);
  }

  console.log("");
  if (report.skills.length === 0) {
    console.log("No skills discovered.");
    return;
  }

  const statusByPath =
    options.status && report.status
      ? new Map(report.status.map((entry) => [entry.filePath, entry]))
      : undefined;

  console.log(chalk.bold(`Loaded skills (${report.skills.length}):`));
  for (const skill of report.skills) {
    const label = chalk.cyan(skill.name);
    const desc = skill.description ? chalk.gray(` — ${skill.description}`) : "";
    console.log(`  - ${label}${desc}`);
    if (options.verbose) {
      console.log(`    path: ${skill.filePath}`);
      if (skill.source) {
        console.log(`    source: ${skill.source}`);
      }
    }
    if (options.status) {
      const status = statusByPath?.get(skill.filePath);
      if (status) {
        const statusLabel = status.eligible ? chalk.green("eligible") : chalk.yellow("needs setup");
        console.log(`    status: ${statusLabel}`);
        const missingParts: string[] = [];
        if (status.missing.bins.length > 0) {
          missingParts.push(`bins: ${status.missing.bins.join(", ")}`);
        }
        if (status.missing.anyBins.length > 0) {
          missingParts.push(`anyBins: ${status.missing.anyBins.join(", ")}`);
        }
        if (status.missing.env.length > 0) {
          missingParts.push(`env: ${status.missing.env.join(", ")}`);
        }
        if (status.missing.config.length > 0) {
          missingParts.push(`config: ${status.missing.config.join(", ")}`);
        }
        if (status.missing.os.length > 0) {
          missingParts.push(`os: ${status.missing.os.join(", ")}`);
        }
        if (missingParts.length > 0) {
          console.log(`    missing: ${missingParts.join(" | ")}`);
        }
        if (!status.eligible && status.install.length > 0) {
          const installLine = status.install.map((option) => option.label).join(" | ");
          console.log(`    install: ${installLine}`);
        }
      }
    }
  }
}

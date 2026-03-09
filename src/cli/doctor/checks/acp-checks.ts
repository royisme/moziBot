/**
 * ACP-specific doctor checks
 * Validates ACP configuration consistency without starting runtime processes.
 */

import type { MoziConfig } from "../../../config/schema";
import type { DoctorFinding, DoctorCheckContext } from "../types";

export async function runAcpChecks(
  config: MoziConfig,
  _context: DoctorCheckContext,
): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const acp = config.acp;

  // If ACP is explicitly disabled, report it and skip the rest
  if (acp?.enabled === false) {
    findings.push({
      id: "acp:disabled",
      level: "warn",
      summary: "ACP is disabled (`acp.enabled=false`). No ACP sessions can be created.",
      fixHint: "Set `acp.enabled=true` in your config to enable ACP.",
    });
    return findings;
  }

  // Check: backend is required for ACP to be functional
  const backend = acp?.backend?.trim();
  if (!backend) {
    findings.push({
      id: "acp:no-backend",
      level: "fail",
      summary: "ACP is enabled but `acp.backend` is not set.",
      details:
        "A backend id is required so Mozi knows which ACP runtime plugin to use (e.g. acpx).",
      fixHint: "Set `acp.backend` to the id registered by your ACP runtime plugin.",
    });
  } else {
    findings.push({
      id: "acp:backend-present",
      level: "pass",
      summary: `ACP backend is set: ${backend}`,
    });
  }

  // Build a list of known agent ids for cross-referencing
  const knownAgentIds = listKnownAgentIds(config);

  // Check: dispatch is enabled (warn if not, since ACP sessions without dispatch are limited)
  const dispatchEnabled = acp?.dispatch?.enabled ?? false;
  if (!dispatchEnabled) {
    findings.push({
      id: "acp:dispatch-disabled",
      level: "warn",
      summary: "ACP dispatch is disabled (`acp.dispatch.enabled=false`).",
      details: "ACP sessions will not process incoming messages without dispatch enabled.",
      fixHint: "Set `acp.dispatch.enabled=true` in your config to enable ACP dispatch.",
    });
  } else {
    findings.push({
      id: "acp:dispatch-enabled",
      level: "pass",
      summary: "ACP dispatch is enabled.",
    });
  }

  // Check: defaultAgent exists in agents config
  const defaultAgent = acp?.defaultAgent?.trim();
  if (defaultAgent) {
    if (!knownAgentIds.includes(defaultAgent)) {
      findings.push({
        id: "acp:default-agent-unknown",
        level: "fail",
        summary: `ACP defaultAgent "${defaultAgent}" is not defined in agents config.`,
        fixHint: `Add an agent with id "${defaultAgent}" to your agents config, or update acp.defaultAgent.`,
      });
    } else {
      findings.push({
        id: "acp:default-agent-valid",
        level: "pass",
        summary: `ACP defaultAgent "${defaultAgent}" is defined in agents config.`,
      });
    }
  } else if (knownAgentIds.length === 0) {
    findings.push({
      id: "acp:no-default-agent",
      level: "warn",
      summary: "No ACP defaultAgent configured and no agents defined.",
      fixHint: "Set `acp.defaultAgent` to the id of the agent that should handle ACP sessions.",
    });
  } else {
    findings.push({
      id: "acp:no-default-agent",
      level: "warn",
      summary: "No ACP defaultAgent configured.",
      details:
        "Without a defaultAgent, ACP spawn will fall back to the first allowed or defined agent.",
      fixHint: "Set `acp.defaultAgent` to the id of the agent that should handle ACP sessions.",
    });
  }

  // Check: allowedAgents all exist in agents config
  const allowedAgents = acp?.allowedAgents ?? [];
  for (const agentId of allowedAgents) {
    if (!knownAgentIds.includes(agentId)) {
      findings.push({
        id: "acp:allowed-agent-unknown",
        level: "fail",
        summary: `ACP allowedAgents references unknown agent: "${agentId}"`,
        fixHint: `Add an agent with id "${agentId}" to your agents config, or remove it from acp.allowedAgents.`,
      });
    }
  }
  if (allowedAgents.length > 0) {
    const unknownCount = allowedAgents.filter((id) => !knownAgentIds.includes(id)).length;
    if (unknownCount === 0) {
      findings.push({
        id: "acp:allowed-agents-valid",
        level: "pass",
        summary: `All ${allowedAgents.length} ACP allowedAgents are defined in agents config.`,
      });
    }
  }

  // Check: runtime.installCommand presence when ACP is enabled
  const installCommand = acp?.runtime?.installCommand?.trim();
  if (!installCommand) {
    findings.push({
      id: "acp:no-install-command",
      level: "warn",
      summary: "No ACP runtime install command configured (`acp.runtime.installCommand`).",
      details: "Without an install command, operators cannot be guided to set up the ACP runtime.",
      fixHint:
        "Set `acp.runtime.installCommand` to the shell command that installs the ACP runtime (e.g. `npm install -g acpx`).",
    });
  } else {
    findings.push({
      id: "acp:install-command-present",
      level: "pass",
      summary: `ACP runtime install command: ${installCommand}`,
    });
  }

  // Check: stream config bounds
  const stream = acp?.stream;
  if (stream?.coalesceIdleMs !== undefined && stream.coalesceIdleMs <= 0) {
    findings.push({
      id: "acp:stream-coalesce-invalid",
      level: "fail",
      summary: `ACP stream.coalesceIdleMs must be a positive integer, got: ${stream.coalesceIdleMs}`,
      fixHint: "Set `acp.stream.coalesceIdleMs` to a positive integer (e.g. 200).",
    });
  }
  if (stream?.maxChunkChars !== undefined && stream.maxChunkChars <= 0) {
    findings.push({
      id: "acp:stream-max-chunk-invalid",
      level: "fail",
      summary: `ACP stream.maxChunkChars must be a positive integer, got: ${stream.maxChunkChars}`,
      fixHint: "Set `acp.stream.maxChunkChars` to a positive integer (e.g. 2000).",
    });
  }

  // Check: deprecated dispatchEnabled field
  const rawAcp = acp as Record<string, unknown> | undefined;
  if (typeof rawAcp?.["dispatchEnabled"] === "boolean") {
    findings.push({
      id: "acp:legacy-dispatch-enabled",
      level: "warn",
      summary: "`acp.dispatchEnabled` is deprecated. Use `acp.dispatch.enabled` instead.",
      fixHint: "Replace `acp.dispatchEnabled` with `acp.dispatch.enabled` in your config.",
    });
  }

  return findings;
}

function listKnownAgentIds(config: MoziConfig): string[] {
  const agents = config.agents ?? {};
  return Object.keys(agents).filter((id) => id !== "defaults");
}

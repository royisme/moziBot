import type { AgentConfig, Binding } from "./types";

export class AgentBindings {
  private agents: Map<string, AgentConfig> = new Map();
  private bindings: Binding[] = [];
  private defaultAgentId: string = "main";

  load(config: { agents?: AgentConfig[]; bindings?: Binding[]; defaultAgent?: string }): void {
    if (config.agents) {
      for (const agent of config.agents) {
        this.agents.set(agent.id, agent);
      }
    }
    if (config.bindings) {
      this.bindings = config.bindings;
    }
    if (config.defaultAgent) {
      this.defaultAgentId = config.defaultAgent;
    }
  }

  getAgent(agentId: string): AgentConfig | undefined {
    return this.agents.get(agentId);
  }

  listAgents(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  resolve(params: { channel: string; peerId: string; peerKind: "dm" | "group" }): AgentConfig {
    for (const binding of this.bindings) {
      const match = binding.match;

      // Check channel match
      if (match.channel && match.channel !== params.channel) {
        continue;
      }

      // Check peer match
      if (match.peer) {
        if (match.peer.id && match.peer.id !== params.peerId) {
          continue;
        }
        if (match.peer.kind && match.peer.kind !== params.peerKind) {
          continue;
        }
      }

      const agent = this.agents.get(binding.agentId);
      if (agent) {
        return agent;
      }
    }

    return this.getDefault();
  }

  getDefault(): AgentConfig {
    const agent = this.agents.get(this.defaultAgentId);
    if (!agent) {
      throw new Error(`Default agent ${this.defaultAgentId} not found`);
    }
    return agent;
  }
}

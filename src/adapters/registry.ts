import { AgentsConfig } from "../config/config";
import { AgentAdapter } from "./agent-adapter";
import { QoderAdapter } from "./qoder-adapter";
import { CodexAdapter } from "./codex-adapter";
import { ShellAdapter } from "./shell-adapter";
import { BaseAdapter } from "./base-adapter";
import { CreateSessionOptions } from "./agent-adapter";

/** Generic fallback for any agent declared in config but without a dedicated adapter. */
class GenericAdapter extends BaseAdapter {
  readonly id: string;
  readonly name: string;
  constructor(id: string, private command: string) {
    super();
    this.id = id;
    this.name = id.charAt(0).toUpperCase() + id.slice(1);
  }
  launchCommand(options: CreateSessionOptions): string {
    void options;
    return this.command;
  }
  initialInput(options: CreateSessionOptions): string | undefined {
    return options.task;
  }
}

/**
 * Registry mapping agent ids -> adapters. Enabled agents come from config;
 * adding a new CLI agent means adding (or reusing) one adapter only.
 */
export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();

  constructor(agents: AgentsConfig) {
    for (const [id, cfg] of Object.entries(agents)) {
      if (!cfg.enabled) continue;
      this.register(this.build(id, cfg.command));
    }
    // shell is always available for terminal-style sessions.
    if (!this.adapters.has("shell"))
      this.register(new ShellAdapter(agents.shell?.command ?? "bash"));
  }

  private build(id: string, command: string): AgentAdapter {
    switch (id) {
      case "qoder":
        return new QoderAdapter(command);
      case "codex":
        return new CodexAdapter(command);
      case "shell":
        return new ShellAdapter(command);
      default:
        return new GenericAdapter(id, command);
    }
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }
}

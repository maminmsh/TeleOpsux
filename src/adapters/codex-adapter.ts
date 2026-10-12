import { BaseAdapter } from "./base-adapter";
import { CreateSessionOptions } from "./agent-adapter";

/** Codex CLI adapter (docs §72 Phase 7 — multi-agent). */
export class CodexAdapter extends BaseAdapter {
  readonly id = "codex";
  readonly name = "Codex";

  constructor(private command = "codex") {
    super();
  }

  /** Preflight resolves + validates this before any session starts. */
  get executable(): string {
    return this.command;
  }

  launchCommand(options: CreateSessionOptions): string {
    // Prefer the host-resolved absolute path (tmux PATH may differ from login).
    const bin = options.resolvedCommand ?? this.command;
    const task = options.task;
    if (task) {
      // codex "PROMPT" runs a one-shot task; falls back to interactive if none.
      return `${bin} ${JSON.stringify(task)}`;
    }
    return bin;
  }

  initialInput(options: CreateSessionOptions): string | undefined {
    return options.task ? undefined : options.task;
  }
}

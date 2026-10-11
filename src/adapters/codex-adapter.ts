import { BaseAdapter } from "./base-adapter";
import { CreateSessionOptions } from "./agent-adapter";

/** Codex CLI adapter (docs §72 Phase 7 — multi-agent). */
export class CodexAdapter extends BaseAdapter {
  readonly id = "codex";
  readonly name = "Codex";

  constructor(private command = "codex") {
    super();
  }

  launchCommand(options: CreateSessionOptions): string {
    const task = options.task;
    if (task) {
      // codex "PROMPT" runs a one-shot task; falls back to interactive if none.
      return `${this.command} ${JSON.stringify(task)}`;
    }
    return this.command;
  }

  initialInput(options: CreateSessionOptions): string | undefined {
    return options.task ? undefined : options.task;
  }
}

import { BaseAdapter } from "./base-adapter";
import { CreateSessionOptions } from "./agent-adapter";

/**
 * Qoder CLI adapter (docs §72 Phase 2). Qoder is the reference agent but lives
 * entirely in this adapter — the core never mentions Qoder-specific behaviour.
 */
export class QoderAdapter extends BaseAdapter {
  readonly id = "qoder";
  readonly name = "Qoder";

  constructor(private command = "qoder") {
    super();
  }

  launchCommand(options: CreateSessionOptions): string {
    void options;
    return this.command;
  }

  initialInput(options: CreateSessionOptions): string | undefined {
    return options.task;
  }

  protected override approvalPatterns = [
    /\b(qoder (needs|requires) approval|approve (this|the) (action|command))\b/i,
    /\b(allow (qoder|this) to|run (this|the) command\?)\b/i,
    /\[y\/n\]|\(yes\/no\)/i,
    /waiting for approval/i,
  ];
}

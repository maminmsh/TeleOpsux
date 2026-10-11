import { Config } from "../config/config";

export type PolicyDecision = "allow" | "approval" | "deny";

/**
 * Policy Engine (docs §30). Maps a command to a decision using configured
 * allow / approval lists. Denied by default for anything matching a destructive
 * root token, so unlisted powerful commands never run silently.
 */
export class PolicyEngine {
  constructor(private config: Config) {}

  private tokens(command: string): string[] {
    return command.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  private matches(command: string, patterns: string[]): boolean {
    const cmd = command.trim().toLowerCase();
    return patterns.some((p) => {
      const pat = p.trim().toLowerCase();
      return cmd === pat || cmd.startsWith(pat + " ") || cmd.includes(pat);
    });
  }

  decide(command: string): PolicyDecision {
    const toks = this.tokens(command);
    if (toks.length === 0) return "deny";

    // Always-gated privileged verbs, regardless of config lists.
    const hardApproval = ["sudo", "rm", "shutdown", "reboot", "mkfs", "dd"];
    if (toks.some((t) => hardApproval.includes(t))) return "approval";
    if (toks[0] === "systemctl" && toks.some((t) => ["restart", "stop", "kill"].includes(t)))
      return "approval";

    if (this.matches(command, this.config.policy.approval_required)) return "approval";
    if (this.matches(command, this.config.policy.allowed)) return "allow";

    // Read-only by default: unrecognised commands require approval rather than
    // being auto-allowed (docs §70 security boundary).
    return "approval";
  }
}

import { BaseAdapter, tailLines } from "./base-adapter";
import { CreateSessionOptions } from "./agent-adapter";

/** The only credential path this adapter will read: `$HOME/.teleops-credentials/teleops-session-<id>.key`. */
const SECRET_FILE_PATH_RE = /^\$HOME\/\.teleops-credentials\/teleops-session-\d+\.key$/;

/**
 * Qoder CLI adapter (docs §72 Phase 2). Qoder is the reference agent but lives
 * entirely in this adapter — the core never mentions Qoder-specific behaviour.
 *
 * Credentials: qoder requires the OWNING user's own API key (never a shared
 * server login). The key travels in a 0600 file written by SessionManager via
 * stdin; this adapter's launch command reads it at runtime and deletes it
 * immediately, so the plaintext never appears in a command line, pane history,
 * capture, or log.
 */
export class QoderAdapter extends BaseAdapter {
  readonly id = "qoder";
  readonly name = "Qoder";
  /** Official Qoder CLI environment variable for a Personal Access Token. */
  readonly credentialEnvVar = "QODER_PERSONAL_ACCESS_TOKEN";

  constructor(private command = "qoder") {
    super();
  }

  launchCommand(options: CreateSessionOptions): string {
    const f = options.secretFilePath;
    if (!f) return this.command;
    // TeleOps-generated path only: $HOME + a fixed directory + a numeric id.
    // Anything else (quotes, backticks, semicolons, spaces) is refused.
    if (!SECRET_FILE_PATH_RE.test(f))
      throw new Error("credential file path is not a TeleOps-generated path");
    // the pane command shows only the FILE PATH; $(cat …) runs inside the
    // pane's shell at launch, and the file is gone once read
    return (
      // Clear both the current PAT variable and the project's former variable:
      // a session must never silently inherit a server-wide credential.
      `sh -c 'unset ${this.credentialEnvVar} QODER_API_KEY; ` +
      `${this.credentialEnvVar}="$(cat "${f}")"; rm -f "${f}"; ` +
      `export ${this.credentialEnvVar}; exec ${this.command}'`
    );
  }

  initialInput(options: CreateSessionOptions): string | undefined {
    return options.task;
  }

  /** Auth failures are credential problems, not task problems — no secret echoes. */
  detectCredentialError(output: string): boolean {
    // Only the fresh tail counts: old scrollback would re-report a fixed key.
    const tail = tailLines(output, 10).join("\n");
    return (
      /\b(invalid|expired|bad)\s+(api[-\s]?key|key|token)\b/i.test(tail) ||
      /\bauthentication\s+(failed|required|error)\b/i.test(tail) ||
      /\b(invalid|expired)\s+credentials\b/i.test(tail) ||
      /\bqoder\b[^\n]{0,60}\b(unauthorized|forbidden|401|403)\b/i.test(tail) ||
      /\bplease\s+(log\s?in|login|re-?authenticate)\b.*\bqoder\b/i.test(tail)
    );
  }

  protected override approvalPatterns = [
    /\b(qoder (needs|requires) approval|approve (this|the) (action|command))\b/i,
    /\b(allow (qoder|this) to|run (this|the) command\?)\b/i,
    /\[y\/n\]|\(yes\/no\)/i,
    /waiting for approval/i,
  ];
}

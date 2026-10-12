import { SessionStatus } from "../shared/types";

export interface WaitingState {
  kind: "input" | "approval";
  reason: string;
}

export interface ErrorSignal {
  kind: "test_failure" | "build_failure" | "runtime" | "generic";
  detail: string;
}

export interface CreateSessionOptions {
  cwd: string;
  project?: string;
  task?: string;
  /**
   * Shell-readable path (TeleOps-authored, e.g. "$HOME/.teleops-credentials/…")
   * of a 0600 file on the session host containing the OWNER's API key for this
   * launch only. Adapters must read it at runtime (cat), never interpolate its
   * content into the command line, and delete the file after reading.
   */
  secretFilePath?: string;
  /**
   * Absolute agent executable resolved by the launch preflight ON THE SESSION
   * HOST (see SessionManager). Adapters must exec this instead of the bare
   * configured name when present: a tmux pane inherits the tmux server's
   * environment, whose PATH frequently differs from the interactive one that
   * found the binary — an absolute path removes the reliance on PATH entirely.
   */
  resolvedCommand?: string;
}

export interface SessionSummary {
  agent: string;
  duration: string;
  completed: string[];
  failed: string[];
  current: string;
  lastQuestion: string | null;
  changedFiles: number | null;
  lastCommit: string | null;
}

/**
 * Agent adapters are the only place agent-specific knowledge lives (docs §4.2,
 * §25). The core treats every agent as a persistent tmux terminal; adapters
 * customise how it is launched and how its output is interpreted.
 */
export interface AgentAdapter {
  readonly id: string;
  readonly name: string;

  /**
   * When the agent is launched via a standalone executable, the configured
   * command name or path. SessionManager resolves + validates it ON THE
   * SESSION HOST (login-shell PATH) before launch and passes the absolute
   * result back through CreateSessionOptions.resolvedCommand. Shell-style
   * adapters that need no external binary may omit it.
   */
  readonly executable?: string;

  /**
   * When set, every session of this agent needs the OWNER's own per-user
   * credential (fail-closed — no shared server login). The value is the env
   * var the launch command exports, e.g. "QODER_PERSONAL_ACCESS_TOKEN".
   */
  readonly credentialEnvVar?: string;

  /** Command line launched inside the tmux pane to start the agent. */
  launchCommand(options: CreateSessionOptions): string;

  /** First input to send once the agent is up (e.g. the task prompt). */
  initialInput?(options: CreateSessionOptions): string | undefined;

  /** Detect that the agent is blocked awaiting the user. */
  detectWaiting(output: string): WaitingState | null;

  /** Detect a failed command / error worth surfacing. */
  detectError(output: string): ErrorSignal | null;

  /**
   * Detect an AUTH failure specific to this agent's credential (invalid /
   * expired / not logged in). When true, the core marks the OWNER's credential
   * status invalid — never logging or transmitting the secret value.
   */
  detectCredentialError?(output: string): boolean;

  /** Best-effort status classification from raw output + liveness. */
  classifyStatus(output: string, alive: boolean): SessionStatus;

  /** Rule-based summary (docs §9) — can later be swapped for an AI summary. */
  summarize(output: string, meta: { startedAtMs: number }): SessionSummary;
}

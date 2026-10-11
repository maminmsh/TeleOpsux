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

  /** Command line launched inside the tmux pane to start the agent. */
  launchCommand(options: CreateSessionOptions): string;

  /** First input to send once the agent is up (e.g. the task prompt). */
  initialInput?(options: CreateSessionOptions): string | undefined;

  /** Detect that the agent is blocked awaiting the user. */
  detectWaiting(output: string): WaitingState | null;

  /** Detect a failed command / error worth surfacing. */
  detectError(output: string): ErrorSignal | null;

  /** Best-effort status classification from raw output + liveness. */
  classifyStatus(output: string, alive: boolean): SessionStatus;

  /** Rule-based summary (docs §9) — can later be swapped for an AI summary. */
  summarize(output: string, meta: { startedAtMs: number }): SessionSummary;
}

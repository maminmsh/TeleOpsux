import { shq } from "../exec/exec-runner";
import type { ExecRunner } from "../exec/exec-runner";
import { LocalRunner } from "../exec/local-runner";

/**
 * Thin wrapper around the tmux CLI (docs §24). All calls go through an
 * ExecRunner with an argument array so user-provided text is never interpreted
 * by a shell — the primary defence against command injection at the process
 * layer. With an SshRunner the same calls execute tmux on the remote host.
 */
export class Tmux {
  constructor(
    private prefix: string,
    private runner: ExecRunner = new LocalRunner(),
  ) {}

  /** The transport the panes actually live on — preflight must resolve there. */
  get execRunner(): ExecRunner {
    return this.runner;
  }

  qualified(name: string): string {
    return `${this.prefix}-${name}`;
  }

  async available(): Promise<boolean> {
    const r = await this.runner.exec("tmux", ["-V"], { timeoutMs: 10_000 });
    return r.code === 0;
  }

  async listSessions(): Promise<string[]> {
    const r = await this.runner.exec("tmux", ["ls", "-F", "#S"]);
    if (r.code !== 0) return [];
    return r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.startsWith(`${this.prefix}-`));
  }

  async exists(name: string): Promise<boolean> {
    const sessions = await this.listSessions();
    return sessions.includes(this.qualified(name));
  }

  /**
   * Create a detached session. When `initialCommand` is given it becomes the
   * pane's OWN command (executed by tmux's default-shell) — it is never typed
   * into a surviving interactive shell, so a failed or exited agent takes the
   * pane down with it and chat input can never fall through to a bare prompt.
   * `remain-on-exit` keeps the dead pane around just long enough for
   * paneStatus/capturePane to read the real exit code and final output.
   * Without a command the pane is an ordinary interactive shell (terminal use).
   */
  async newSession(
    name: string,
    cwd: string,
    initialCommand?: string,
  ): Promise<void> {
    const target = this.qualified(name);
    // remain-on-exit for BOTH modes: a bare terminal shell that the user ends
    // with `exit` must still be observable as DEAD (pane_dead) instead of
    // silently vanishing, so no UI can ever show a live terminal with no
    // process behind it.
    const args = ["new-session", "-d", "-o", "remain-on-exit=on", "-s", target, "-c", cwd];
    if (initialCommand) args.push(initialCommand);
    const r = await this.runner.exec("tmux", args);
    if (r.code !== 0)
      throw new Error(`tmux new-session failed: ${(r.stderr || r.stdout || `exit code ${r.code}`).toString().trim()}`);
  }

  /**
   * Liveness of the session's pane. Null means the session is gone entirely.
   * With remain-on-exit a dead pane still EXISTS, so `exists()` alone is no
   * longer a liveness signal — every "is the agent running?" check must go
   * through this (or isAlive).
   */
  async paneStatus(
    name: string,
  ): Promise<{ dead: boolean; exitCode: number | null; pid: number | null } | null> {
    const r = await this.runner.exec("tmux", [
      "display-message",
      "-p",
      "-t",
      this.qualified(name),
      "#{pane_dead};#{pane_dead_status};#{pane_pid}",
    ]);
    if (r.code !== 0) return null;
    const [dead, code, pid] = r.stdout.trim().split(";");
    const parsedPid = parseInt(pid ?? "", 10);
    const parsedCode = parseInt(code ?? "", 10);
    return {
      dead: dead === "1",
      exitCode: Number.isFinite(parsedCode) ? parsedCode : null,
      pid: Number.isFinite(parsedPid) ? parsedPid : null,
    };
  }

  /** Whether the pane exists AND its process is still running. */
  async isAlive(name: string): Promise<boolean> {
    const st = await this.paneStatus(name);
    return st !== null && !st.dead;
  }

  async panePid(name: string): Promise<number | null> {
    return (await this.paneStatus(name))?.pid ?? null;
  }

  /** Send literal text, then optionally press Enter. Uses -l to avoid key-name parsing. */
  private async sendKeysText(
    name: string,
    text: string,
    enter: boolean,
  ): Promise<void> {
    const target = this.qualified(name);
    const typed = await this.runner.exec("tmux", ["send-keys", "-t", target, "-l", text]);
    if (typed.code !== 0)
      throw new Error(`tmux send-keys failed: ${(typed.stderr || typed.stdout || `exit code ${typed.code}`).trim()}`);
    if (enter) {
      const ret = await this.runner.exec("tmux", ["send-keys", "-t", target, "Enter"]);
      if (ret.code !== 0)
        throw new Error(`tmux send-keys Enter failed: ${(ret.stderr || ret.stdout || `exit code ${ret.code}`).trim()}`);
    }
  }

  /** Send a user/agent message as a line of input. */
  async sendInput(name: string, text: string): Promise<void> {
    await this.sendKeysText(name, text, true);
  }

  /** Send a special key sequence (e.g. C-c) verbatim, not as literal text. */
  async sendKey(name: string, key: string): Promise<void> {
    const r = await this.runner.exec("tmux", ["send-keys", "-t", this.qualified(name), key]);
    if (r.code !== 0)
      throw new Error(`tmux send-keys failed: ${(r.stderr || r.stdout || `exit code ${r.code}`).trim()}`);
  }

  async capturePane(name: string, lines = 200): Promise<string> {
    const r = await this.runner.exec("tmux", [
      "capture-pane",
      "-p",
      "-t",
      this.qualified(name),
      "-S",
      `-${lines}`,
    ]);
    return r.code === 0 ? r.stdout : "";
  }

  async killSession(name: string): Promise<void> {
    await this.runner.exec("tmux", ["kill-session", "-t", this.qualified(name)]);
  }

  /**
   * Stream pane output to a file on the pane's host via tmux pipe-pane.
   * `shellCommand` is a TeleOps-authored shell line (not user text); the log
   * path embedded in it is shq-quoted. Best-effort: tmux <3.2 or a dead pane
   * returns non-zero — callers must treat failure as a warning, not an error.
   */
  async pipePane(name: string, shellCommand: string): Promise<boolean> {
    const r = await this.runner.exec("tmux", [
      "pipe-pane",
      "-O",
      "-o",
      "-t",
      this.qualified(name),
      shellCommand,
    ]);
    return r.code === 0;
  }

  /** Shell line for appending stdin to a file; path is escaped here so callers never build raw shell. */
  static appendToShell(remotePath: string): string {
    return `cat >> ${shq(remotePath)}`;
  }
}

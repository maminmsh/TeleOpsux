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

  /** Create a detached session and optionally launch an initial command. */
  async newSession(
    name: string,
    cwd: string,
    initialCommand?: string,
  ): Promise<void> {
    const target = this.qualified(name);
    const r = await this.runner.exec("tmux", ["new-session", "-d", "-s", target, "-c", cwd]);
    if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr || r.stdout}`.trim());
    if (initialCommand) {
      await this.sendKeysText(name, initialCommand, true);
    }
  }

  async panePid(name: string): Promise<number | null> {
    const r = await this.runner.exec("tmux", [
      "display-message",
      "-p",
      "-t",
      this.qualified(name),
      "#{pane_pid}",
    ]);
    if (r.code !== 0) return null;
    const pid = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  }

  /** Send literal text, then optionally press Enter. Uses -l to avoid key-name parsing. */
  private async sendKeysText(
    name: string,
    text: string,
    enter: boolean,
  ): Promise<void> {
    const target = this.qualified(name);
    await this.runner.exec("tmux", ["send-keys", "-t", target, "-l", text]);
    if (enter) await this.runner.exec("tmux", ["send-keys", "-t", target, "Enter"]);
  }

  /** Send a user/agent message as a line of input. */
  async sendInput(name: string, text: string): Promise<void> {
    await this.sendKeysText(name, text, true);
  }

  /** Send a special key sequence (e.g. C-c) verbatim, not as literal text. */
  async sendKey(name: string, key: string): Promise<void> {
    await this.runner.exec("tmux", ["send-keys", "-t", this.qualified(name), key]);
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

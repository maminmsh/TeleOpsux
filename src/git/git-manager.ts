import type { ExecRunner } from "../exec/exec-runner";
import { LocalRunner } from "../exec/local-runner";

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  modified: string[];
  clean: boolean;
}

export interface GitOpResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Git Manager (docs §15/§16). Every call uses an ExecRunner with an argument
 * array, never a shell string, so paths and messages cannot inject commands;
 * an SshRunner transparently runs git on the remote host. Destructive
 * operations (commit/push) are gated upstream by the Approval + Policy layers.
 */
export class GitManager {
  /** Optional hook: receives {cwd, subcommand, stderr} on failed git ops (repo + command only, never message bodies). */
  constructor(
    private runner: ExecRunner = new LocalRunner(),
    private onError?: (info: { cwd: string; command: string; stderr: string }) => void,
  ) {}

  private async git(
    cwd: string,
    args: string[],
    reportError = false,
  ): Promise<GitOpResult> {
    const r = await this.runner.exec("git", args, {
      cwd,
      timeoutMs: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const stderr =
      r.stderr ||
      (r.timedOut
        ? "git timed out"
        : r.code !== 0
          ? `git failed (exit ${r.code ?? "?"})`
          : "");
    // Only mutating ops report to the tracker — probes (rev-list on a branch
    // without upstream, etc.) fail routinely and would only add noise.
    if (r.code !== 0 && stderr && reportError && this.onError)
      this.onError({ cwd, command: args[0] ?? "?", stderr });
    return { ok: r.code === 0, stdout: r.stdout, stderr };
  }

  async isRepo(cwd: string): Promise<boolean> {
    const r = await this.git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return r.ok && r.stdout.trim() === "true";
  }

  async currentBranch(cwd: string): Promise<string | null> {
    const r = await this.git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return r.ok ? r.stdout.trim() : null;
  }

  async status(cwd: string): Promise<GitStatus> {
    const branch = (await this.currentBranch(cwd)) ?? "(detached)";
    const [porcelain, counts] = await Promise.all([
      this.git(cwd, ["status", "--porcelain"]),
      this.git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    ]);
    const modified = porcelain.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let ahead = 0;
    let behind = 0;
    if (counts.ok) {
      const parts = counts.stdout.trim().split(/\s+/);
      behind = parseInt(parts[0] ?? "0", 10) || 0;
      ahead = parseInt(parts[1] ?? "0", 10) || 0;
    }
    return { branch, ahead, behind, modified, clean: modified.length === 0 };
  }

  async diff(cwd: string, opts?: { staged?: boolean; maxLines?: number }) {
    const args = ["diff", ...(opts?.staged ? ["--cached"] : []), "--stat"];
    const stat = await this.git(cwd, args);
    const full = await this.git(cwd, [
      "diff",
      ...(opts?.staged ? ["--cached"] : []),
    ]);
    const max = opts?.maxLines ?? 400;
    const body = full.stdout.split("\n").slice(0, max).join("\n");
    return { stat: stat.stdout, diff: body, truncated: full.stdout.split("\n").length > max };
  }

  async numstat(cwd: string): Promise<{ files: number; insertions: number; deletions: number }> {
    const r = await this.git(cwd, ["diff", "--numstat"]);
    let insertions = 0;
    let deletions = 0;
    const lines = r.stdout.split("\n").filter(Boolean);
    for (const l of lines) {
      const [i, d] = l.split("\t");
      insertions += parseInt(i ?? "0", 10) || 0;
      deletions += parseInt(d ?? "0", 10) || 0;
    }
    return { files: lines.length, insertions, deletions };
  }

  async log(cwd: string, n = 10): Promise<string> {
    const r = await this.git(cwd, [
      "log",
      `-${n}`,
      "--pretty=format:%h %s (%an, %ar)",
    ]);
    return r.stdout;
  }

  async branches(cwd: string): Promise<string[]> {
    const r = await this.git(cwd, ["branch", "--format=%(refname:short)"]);
    return r.stdout.split("\n").map((b) => b.trim()).filter(Boolean);
  }

  async checkout(cwd: string, branch: string): Promise<GitOpResult> {
    return this.git(cwd, ["checkout", branch], true);
  }

  async add(cwd: string, paths: string[] = ["-A"]): Promise<GitOpResult> {
    return this.git(cwd, ["add", ...paths], true);
  }

  async commit(cwd: string, message: string): Promise<GitOpResult> {
    return this.git(cwd, ["commit", "-m", message], true);
  }

  async pull(cwd: string): Promise<GitOpResult> {
    return this.git(cwd, ["pull", "--ff-only"], true);
  }

  async push(cwd: string, remote = "origin", branch?: string): Promise<GitOpResult> {
    const args = ["push", remote];
    if (branch) args.push(branch);
    return this.git(cwd, args, true);
  }

  async stash(cwd: string): Promise<GitOpResult> {
    return this.git(cwd, ["stash"], true);
  }
}

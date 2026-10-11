import { shq } from "../exec/exec-runner";
import type { ExecOptions, ExecResult, ExecRunner } from "../exec/exec-runner";
import type { SshConnection } from "./ssh-connection";

/**
 * Runs argv-style commands on the remote host. Every token is single-quoted
 * via shq before being handed to the ssh login shell, so no user-controlled
 * text can expand into shell syntax — same invariant as execFile locally.
 */
export class SshRunner implements ExecRunner {
  readonly kind = "ssh" as const;

  /** onFailure receives only the command NAME + error text — never full argv. */
  constructor(
    private conn: SshConnection,
    private onFailure?: (cmd: string, message: string) => void,
  ) {}

  async exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    const line = [cmd, ...args].map(shq).join(" ");
    const full = opts?.cwd ? `cd ${shq(opts.cwd)} && ${line}` : line;
    const r = await this.conn.execLine(full, opts);
    if (r.code === null && this.onFailure) {
      this.onFailure(cmd, r.stderr || "ssh exec failed");
    }
    return r;
  }

  async execScript(script: string, opts?: ExecOptions): Promise<ExecResult> {
    const r = await this.conn.execLine(script, opts);
    if (r.code === null && this.onFailure) {
      this.onFailure("script", r.stderr || "ssh exec failed");
    }
    return r;
  }
}

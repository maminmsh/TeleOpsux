export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Written to the child/channel stdin, then EOF. */
  input?: string;
  maxBuffer?: number;
}

export interface ExecResult {
  /** Numeric exit code; 124 on timeout; null only when the process could not start (e.g. ssh down). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface ExecRunner {
  readonly kind: "local" | "ssh";
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  /**
   * Run a fixed TeleOps-authored shell script through a shell.
   * NEVER feed user-controlled text into it — use exec() with argv for that.
   */
  execScript(script: string, opts?: ExecOptions): Promise<ExecResult>;
}

/** POSIX single-quote escaping — the ONLY place shell quoting happens. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

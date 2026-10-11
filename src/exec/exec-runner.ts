export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Written to the child/channel stdin, then EOF. */
  input?: string;
  maxBuffer?: number;
  /**
   * Extra environment for the child. A value of `undefined` REMOVES the
   * variable from the inherited environment — this is how a secret is kept out
   * of an argv list without ever being inherited from the parent process.
   * Local transport only; SSH does not forward arbitrary env.
   */
  env?: Record<string, string | undefined>;
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

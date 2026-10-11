import { spawn } from "node:child_process";
import type { ExecOptions, ExecResult, ExecRunner } from "./exec-runner";

/**
 * Build the child environment: inherit ours, then apply overrides. A value of
 * `undefined` deletes the variable, so a secret can be injected for exactly one
 * child without ever appearing in argv or in the parent's environment.
 */
function childEnv(
  overrides: ExecOptions["env"],
): NodeJS.ProcessEnv | undefined {
  if (!overrides) return process.env;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Local runner based on spawn with an argv array (never a shell string for
 * exec()) and stdin support via the `input` option.
 */
export class LocalRunner implements ExecRunner {
  readonly kind = "local" as const;

  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs;
    const maxBuffer = opts?.maxBuffer ?? 4 * 1024 * 1024;
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, { cwd: opts?.cwd, env: childEnv(opts?.env) });
      } catch (e) {
        resolve({ code: null, stdout: "", stderr: (e as Error).message });
        return;
      }
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;
      const finish = (r: ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ...r,
          stderr: truncated ? `${r.stderr}\n[output truncated at ${maxBuffer} bytes]` : r.stderr,
        });
      };
      const timer =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              child.kill("SIGTERM");
              finish({ code: 124, stdout, stderr: stderr || "timed out", timedOut: true });
            }, timeoutMs)
          : undefined;
      child.stdout?.on("data", (c: Buffer) => {
        if (stdout.length < maxBuffer) stdout += c.toString("utf8").slice(0, maxBuffer - stdout.length);
        else truncated = true;
      });
      child.stderr?.on("data", (c: Buffer) => {
        if (stderr.length < maxBuffer) stderr += c.toString("utf8").slice(0, maxBuffer - stderr.length);
        else truncated = true;
      });
      child.on("error", (e) => {
        finish({ code: null, stdout, stderr: e.message });
      });
      child.on("close", (code) => {
        finish({ code, stdout, stderr });
      });
      if (opts?.input !== undefined) {
        child.stdin?.write(opts.input);
      }
      child.stdin?.end();
    });
  }

  async execScript(script: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.exec("sh", ["-c", script], opts);
  }
}

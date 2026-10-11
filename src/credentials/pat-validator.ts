import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecRunner } from "../exec/exec-runner";
import { LocalRunner } from "../exec/local-runner";

/**
 * Outcome of a credential probe. `reason` is always one of a fixed set of safe
 * strings — the CLI's own output is never kept, returned or logged.
 */
export type PatVerdict =
  | { kind: "valid" }
  /** Qoder answered that THIS token is not accepted — the user can act on it. */
  | { kind: "rejected" }
  /** We could not tell (CLI missing, timeout, network). Never guess. */
  | { kind: "unavailable"; reason: string };

/**
 * The supported, non-destructive way to ask "does this PAT work?": the CLI's
 * own model listing authenticates and exits without creating a session,
 * writing files to a workspace or spending tokens on a completion.
 *
 * `--config-dir <private temp dir>` matters: a probe must not consult or disturb
 * any other login, so a `valid` verdict always refers to the submitted token.
 */
const PROBE_ARGS = ["--list-models"];

/** Fixed strings the CLI prints when the token itself is refused. */
const REJECTED_PATTERNS = [
  /token that was rejected/i,
  /invalid[^\n]{0,40}(token|key|credential)/i,
  /(token|key|credential)[^\n]{0,40}invalid/i,
  /unauthorized|401\b/i,
];

/** Printed when the CLI found no credential at all — our env var was ignored. */
const NO_LOGIN_PATTERN = /not logged in/i;

export interface PatValidatorConfig {
  /** `agents.qoder.command` — the same binary the sessions run. */
  command: string;
  enabled: boolean;
  timeoutSeconds: number;
}

export class PatValidator {
  constructor(
    private cfg: PatValidatorConfig,
    private runner: ExecRunner = new LocalRunner(),
  ) {}

  get active(): boolean {
    return this.cfg.enabled;
  }

  /**
   * Checks the token WITHOUT putting it in argv: the child receives it through
   * its environment only, and both the current and the legacy variable are
   * pinned so nothing server-wide can be inherited and mask the result.
   */
  async check(pat: string): Promise<PatVerdict> {
    if (!this.cfg.enabled) return { kind: "unavailable", reason: "disabled" };
    if (!this.cfg.command.trim()) return { kind: "unavailable", reason: "no_command" };

    let probeDir: string | null = null;
    try {
      probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "teleops-pat-probe-"));
      fs.chmodSync(probeDir, 0o700);
      const r = await this.runner.exec(
        this.cfg.command,
        [...PROBE_ARGS, "--config-dir", probeDir],
        {
          timeoutMs: this.cfg.timeoutSeconds * 1000,
          maxBuffer: 256 * 1024,
          cwd: probeDir,
          env: {
            QODER_PERSONAL_ACCESS_TOKEN: pat,
            QODER_API_KEY: undefined,
            HOME: probeDir,
          },
        },
      );

      if (r.timedOut) return { kind: "unavailable", reason: "timeout" };
      if (r.code === null) return { kind: "unavailable", reason: "spawn_failed" };
      const out = `${r.stdout}\n${r.stderr}`;
      if (r.code === 0) return { kind: "valid" };
      if (REJECTED_PATTERNS.some((re) => re.test(out))) return { kind: "rejected" };
      if (NO_LOGIN_PATTERN.test(out))
        return { kind: "unavailable", reason: "token_not_read" };
      return { kind: "unavailable", reason: "probe_failed" };
    } catch {
      // mkdtemp/permission problems must never block storing a credential
      return { kind: "unavailable", reason: "probe_error" };
    } finally {
      if (probeDir) {
        try {
          fs.rmSync(probeDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }
}

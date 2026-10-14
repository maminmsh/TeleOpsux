import path from "node:path";
import { App } from "../core/container";
import { OutputHub, terminalKey } from "./output-hub";
import { outputDelta } from "../session/session-manager";
import { Tmux } from "../session/tmux";
import { shq } from "../exec/exec-runner";
import {
  stageCredentialFile,
  removeCredentialFile,
} from "../credentials/launch-staging";
import {
  DENY_MESSAGE,
  effectiveActiveHostId,
  isAllowedUser,
} from "../auth/access";

/**
 * The PERSONAL Linux terminal of the Live Session Terminal Mini App — fully
 * INDEPENDENT of AI sessions. Each allowed user gets exactly one DEDICATED
 * tmux session (`term-u<uid>` → `teleops-term-u<uid>`) opened on the active
 * transport (local or the active SSH host) at the transport user's $HOME.
 * That is a real shell: cwd/env persist across commands, long-running
 * processes keep running when the Mini App or browser closes, and Ctrl+C is
 * a real tmux key.
 *
 * `qoder` in this terminal behaves like a managed session: the user's OWN
 * stored PAT is staged to a 0600 file and exported into the login shell at
 * pane start (never in argv/logs), and the binary is preflighted and
 * symlinked into `~/.teleops/bin` on PATH — the same credential path as
 * SessionManager. Pane output is mirrored to a log file via pipe-pane so
 * terminal logs survive close/restart, and the live ring keeps the recent
 * transcript for reconnecting viewers.
 *
 * Isolation guarantees:
 *  - terminal traffic never touches agent panes (different tmux name, and
 *    agent sessions are keyed `s<id>` in the hub while this is `t<uid>`);
 *  - the shell runs as the account TeleOps itself connects with — no sudo,
 *    no cross-user terminals (every uid's pane lives under its own home);
 *  - every entry point re-checks the SERVER-verified user id against the
 *    central allowlist and the active-transport/host consistency rule.
 */

const ALLOWED_KEYS = new Set([
  "C-c",
  "C-d",
  "C-l",
  "C-z",
  "Enter",
  "Escape",
  "Tab",
  "BSpace",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** Poll cadence while someone is watching; capture-pane diffs feed the hub. */
const POLL_MS = 700;
/** Stop polling (shell stays alive AND keeps logging) after this idle time. */
const POLL_IDLE_MS = 2 * 60_000;

interface Term {
  /** Short tmux name, e.g. `term-u42` (Tmux adds the prefix). */
  name: string;
  cwd: string;
  hostId: number | null;
  lastOutput: string;
  lastUsedMs: number;
  pollTimer: NodeJS.Timeout | null;
}

export interface TerminalState {
  active: boolean;
  cwd?: string;
  host_id?: number | null;
}

/**
 * Absolute, symlink-resolved $HOME on the CURRENT transport. Shared by the
 * personal terminal and the Mini App directory browser so both agree on the
 * one allowed root.
 */
export async function resolveTransportHome(app: App): Promise<string> {
  const r = await app.sessions.tmuxTransport.execRunner.exec(
    "sh",
    ["-lc", 'cd "$HOME" && pwd -P'],
    { timeoutMs: 20_000 },
  );
  const home = (r.stdout || "").split("\n")[0]?.trim() ?? "";
  if (r.code !== 0 || !home.startsWith("/"))
    throw new Error(
      `could not resolve the home directory on ${app.sessions.currentHostId == null ? "this machine" : "the active server"} — the terminal cannot open.`,
    );
  return home;
}

export class TerminalService {
  private terms = new Map<number, Term>();

  constructor(private app: App, private hub: OutputHub) {}

  /** The user may act on their own terminal, and only on the active transport. */
  private mustBeAllowed(userId: number): void {
    if (!isAllowedUser(this.app, userId)) throw new Error(DENY_MESSAGE);
    const eff = effectiveActiveHostId(this.app, userId);
    if (eff !== this.app.sessions.currentHostId)
      throw new Error(
        "Your active server differs from the server TeleOps is attached to — switch servers (see /hosts) and reopen the terminal.",
      );
  }

  status(userId: number): TerminalState {
    const t = this.terms.get(userId);
    if (!t) return { active: false };
    return { active: true, cwd: t.cwd, host_id: t.hostId };
  }

  private tmux(): Tmux {
    return this.app.sessions.tmuxTransport;
  }

  /**
   * Open (or reuse) the user's personal shell. tmux availability is checked
   * on the CURRENT transport — remote servers execute tmux on the remote host
   * through the exact runner SessionManager uses.
   */
  async start(userId: number): Promise<TerminalState> {
    this.mustBeAllowed(userId);
    const hostId = this.app.sessions.currentHostId;
    const tmux = this.tmux();

    let t = this.terms.get(userId);
    if (t && t.hostId !== hostId) {
      // The active server changed underneath us — the old shell lives on a
      // transport we no longer speak to. Forget it and open a fresh one.
      this.stopTimer(userId);
      this.terms.delete(userId);
      t = undefined;
    }
    if (t) {
      t.lastUsedMs = Date.now();
      this.ensurePolling(userId, t);
      return this.status(userId);
    }
    if (!(await tmux.available()))
      throw new Error("tmux is not available on this server — the Linux terminal needs it.");

    const name = `term-u${userId}`;
    // Reuse a shell that survived a TeleOps restart — but only a LIVE one:
    // with remain-on-exit a dead pane still exists, and reopening must not
    // resurrect an exited shell as a "connected" terminal.
    if (await tmux.exists(name)) {
      if (!(await tmux.isAlive(name))) await tmux.killSession(name);
    }
    const home = await resolveTransportHome(this.app);
    const notes: string[] = [];
    if (!(await tmux.exists(name))) {
      const initialCommand = await this.buildShellCommand(userId, notes);
      await tmux.newSession(name, home, initialCommand);
      await this.attachFileLog(name, home, userId, notes);
    }
    t = {
      name,
      cwd: home,
      hostId,
      lastOutput: "",
      lastUsedMs: Date.now(),
      pollTimer: null,
    };
    this.terms.set(userId, t);
    const key = terminalKey(userId);
    this.hub.append(key, "system", `terminal opened in ${home}`, true);
    for (const n of notes) this.hub.append(key, "system", n, true);
    this.ensurePolling(userId, t);
    return this.status(userId);
  }

  /**
   * Build the pane's own command: an interactive LOGIN shell (full PATH, so
   * user-installed CLIs resolve like over SSH) with the user's Qoder PAT
   * exported when they have one. The key is staged 0600 and consumed+deleted
   * by the pane at exec — it never appears in argv or logs.
   */
  private async buildShellCommand(userId: number, notes: string[]): Promise<string> {
    const qoderBin = this.app.adapters.get("qoder")?.executable ?? "qoder";
    const exportLines: string[] = [];
    const keyPathExpr = `$HOME/.teleops-credentials/teleops-term-${userId}.key`;
    const creds = this.app.credentials;
    let staged = false;
    try {
      if (creds.hasCredential(userId)) {
        const key = creds.revealForLaunch(userId);
        if (key) {
          await stageCredentialFile(this.tmux().execRunner, keyPathExpr, key);
          staged = true;
          exportLines.push(
            `export QODER_PERSONAL_ACCESS_TOKEN="$(cat "${keyPathExpr}")"; rm -f "${keyPathExpr}"`,
          );
          // Pre-flight the binary like a managed session does, then pin it on
          // PATH via a symlink in ~/.teleops/bin so a bare `qoder` typed in
          // the terminal is the SAME executable the agent panes exec.
          const res = await this.app.sessions.preflightExecutable(qoderBin);
          if (res.ok) {
            const linkName = qoderBin.split("/").pop() || "qoder";
            await this.tmux().execRunner.execScript(
              `mkdir -p "$HOME/.teleops/bin" && ln -sf ${shq(res.path)} "$HOME/.teleops/bin/${linkName}"`,
              { timeoutMs: 20_000 },
            );
            exportLines.push('export PATH="$HOME/.teleops/bin:$PATH"');
          } else {
            notes.push(`⚠️ ${res.error}`);
          }
        }
      } else {
        exportLines.push('export PATH="$HOME/.teleops/bin:$PATH"');
        notes.push(
          "ℹ️ qoder needs your personal key — store it with /qoderkey, then reopen this terminal.",
        );
      }
    } catch (e) {
      // a credential problem must not eat the terminal — open the plain shell
      // and show the real error (requirement: every error surfaces)
      if (staged) void removeCredentialFile(this.tmux().execRunner, keyPathExpr);
      staged = false;
      notes.push(`⚠️ qoder setup in this terminal failed: ${String((e as Error).message)}`);
    }
    if (!staged) {
      // no token line; keep PATH convenience when we managed to compute it
      const pathOnly = exportLines.filter((l) => l.startsWith("export PATH"));
      const prelude = pathOnly.length ? `${pathOnly.join("; ")}; ` : "";
      return `sh -c '${prelude}exec "${'$'}{SHELL:-bash}" -l'`;
    }
    return `sh -c '${exportLines.join("; ")}; exec "${'$'}{SHELL:-bash}" -l'`;
  }

  /**
   * Best-effort pipe-pane file log so terminal output SURVIVES close/restart
   * (same mechanism managed sessions use). Local transport logs under
   * config.paths.log_root/terminals; remote under the user's ~/.teleops/logs.
   */
  private async attachFileLog(
    name: string,
    home: string,
    userId: number,
    notes: string[],
  ): Promise<void> {
    try {
      const local = this.app.sessions.currentHostId == null;
      const dir = local
        ? path.resolve(this.app.config.paths.log_root, "terminals")
        : `${home}/.teleops/logs`;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logPath = `${dir}/term-u${userId}-${stamp}.log`;
      await this.tmux()
        .execRunner.execScript(`mkdir -p ${shq(dir)}`, { timeoutMs: 20_000 })
        .catch(() => undefined);
      const piped = await this.tmux().pipePane(name, Tmux.appendToShell(logPath));
      if (piped)
        notes.push(`📜 terminal log: ${logPath}`);
      else
        notes.push(
          "⚠️ file logging unavailable (old tmux?) — the live transcript still persists in tmux scrollback.",
        );
    } catch (e) {
      notes.push(`⚠️ terminal file log failed: ${String((e as Error).message)}`);
    }
  }

  /** Literal text + Enter — delivered to the SHELL pane only. */
  async sendText(userId: number, text: string): Promise<void> {
    const t = this.mustBeLive(userId);
    await this.assertNotExited(userId, t);
    if (!text) return;
    if (text.length > 4000) throw new Error("Input too long (max 4000 characters).");
    t.lastUsedMs = Date.now();
    this.ensurePolling(userId, t);
    await this.tmux().sendInput(t.name, text);
    // NO local echo: the pane capture diff is the single source of truth,
    // so the command line appears exactly once, with the shell's own result.
  }

  /** Special keys (Ctrl+C etc.) from a fixed allowlist — never arbitrary names. */
  async sendKey(userId: number, key: string): Promise<void> {
    const t = this.mustBeLive(userId);
    if (!ALLOWED_KEYS.has(key)) throw new Error(`Key "${key}" is not allowed.`);
    await this.assertNotExited(userId, t);
    t.lastUsedMs = Date.now();
    this.ensurePolling(userId, t);
    await this.tmux().sendKey(t.name, key);
  }

  /** Input never goes to a shell that has already exited. */
  private async assertNotExited(userId: number, t: Term): Promise<void> {
    if (await this.tmux().isAlive(t.name)) return;
    this.close(userId, /*killPane=*/ true);
    throw new Error("The terminal shell has exited — reopen the terminal.");
  }

  /** Explicit user stop: the ONLY path that kills the personal pane. */
  async stop(userId: number): Promise<void> {
    this.mustBeAllowed(userId);
    this.close(userId, true);
  }

  private mustBeLive(userId: number): Term {
    this.mustBeAllowed(userId);
    const t = this.terms.get(userId);
    if (!t) throw new Error("Terminal is not open — start it first.");
    if (t.hostId !== this.app.sessions.currentHostId)
      throw new Error("The active server changed — close and reopen the terminal.");
    return t;
  }

  private close(userId: number, killPane: boolean): void {
    const t = this.terms.get(userId);
    if (!t) return;
    this.stopTimer(userId);
    this.terms.delete(userId);
    if (killPane && t.hostId === this.app.sessions.currentHostId) {
      void this.tmux()
        .killSession(t.name)
        .catch(() => undefined);
    }
    this.hub.append(terminalKey(userId), "system", "terminal closed", true);
  }

  /**
   * Keep polling cheap: pause when nobody interacts. The tmux pane is NEVER
   * reaped automatically — closing the browser/Mini App must leave the shell
   * (and a running qoder task) alive; only Stop or an exited shell removes it.
   */
  private ensurePolling(userId: number, t: Term): void {
    if (t.pollTimer) return;
    t.pollTimer = setInterval(() => {
      void this.poll(userId).catch(() => undefined);
    }, POLL_MS);
    t.pollTimer.unref?.();
  }

  private stopTimer(userId: number): void {
    const t = this.terms.get(userId);
    if (t?.pollTimer) {
      clearInterval(t.pollTimer);
      t.pollTimer = null;
    }
  }

  private async poll(userId: number): Promise<void> {
    const t = this.terms.get(userId);
    if (!t) return;
    const now = Date.now();
    if (now - t.lastUsedMs > POLL_IDLE_MS && this.hub.subscriberCount(terminalKey(userId)) === 0) {
      this.stopTimer(userId);
      return;
    }
    const output = await this.tmux().capturePane(t.name, 250);
    if (!(await this.tmux().isAlive(t.name))) {
      // The shell exited (e.g. `exit`, or the host went down): drain whatever
      // the dead pane still shows, then tear the terminal down. A terminal
      // must NEVER keep looking live with no process behind it.
      const chunk = outputDelta(t.lastOutput, output);
      if (chunk.trim()) this.hub.append(terminalKey(userId), "shell", chunk, true);
      this.hub.append(
        terminalKey(userId),
        "system",
        "shell process exited — terminal closed (pane was kept for the log)",
        true,
      );
      this.stopTimer(userId);
      this.terms.delete(userId);
      return;
    }
    // Prefix/scroll/redraw-safe diff: appended lines, scrolled remainder and
    // in-place redraws each produce ONLY the real change — no duplicated
    // screen-fulls when tmux wraps or repaints.
    const chunk = outputDelta(t.lastOutput, output);
    t.lastOutput = output;
    if (chunk.trim()) this.hub.append(terminalKey(userId), "shell", chunk, true);
  }

  /** Close every shell's timers without killing panes (TeleOps shutdown). */
  shutdown(): void {
    for (const [, t] of this.terms) {
      if (t.pollTimer) clearInterval(t.pollTimer);
    }
    this.terms.clear();
  }
}

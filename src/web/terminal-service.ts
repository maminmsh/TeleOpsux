import { App } from "../core/container";
import { OutputHub } from "./output-hub";
import { outputDelta } from "../session/session-manager";
import { DENY_MESSAGE, resolveSession } from "../auth/access";

/**
 * Persistent interactive Linux terminals for the Live Session Terminal Mini
 * App. Each terminal is a DEDICATED tmux session (`term-<sessionId>`, which
 * the Tmux wrapper qualifies to `teleops-term-<id>`) opened on the SAME
 * transport the session itself runs on (local or the active SSH host), at the
 * session's project cwd. That gives a real PTY-like shell: cwd/env persist
 * across commands, long-running processes keep running, Ctrl+C is delivered
 * as an actual tmux key — unlike a one-shot exec per input.
 *
 * Isolation guarantees:
 *  - the agent pane is never touched by terminal traffic (different tmux name);
 *  - terminal input goes ONLY to the shell, agent input ONLY via
 *    SessionManager.sendInput — the two paths never merge;
 *  - the shell runs as the service account TeleOps itself connects with
 *    (local user / SSH user). No sudo, no root escalation, ever;
 *  - every entry point re-resolves the session against the central auth
 *    layer with the SERVER-verified user id before touching tmux.
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
/** Stop polling (shell stays alive) after this idle time. */
const POLL_IDLE_MS = 2 * 60_000;
/** Reap the shell itself after this idle time. */
const TERM_GC_MS = 30 * 60_000;

interface Term {
  /** Short tmux name, e.g. `term-4` (Tmux adds the prefix). */
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

export class TerminalService {
  private terms = new Map<number, Term>();
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(private app: App, private hub: OutputHub) {}

  /** Server-side ownership check — callers pass the INIT-DATA-verified uid. */
  private mustOwn(userId: number, sessionId: number) {
    const s = resolveSession(this.app, userId, sessionId);
    if (!s) throw new Error(DENY_MESSAGE);
    return s;
  }

  status(sessionId: number): TerminalState {
    const t = this.terms.get(sessionId);
    if (!t) return { active: false };
    return { active: true, cwd: t.cwd, host_id: t.hostId };
  }

  /**
   * Open (or reuse) the shell for a session. tmux availability is checked on
   * the CURRENT transport — remote projects execute tmux on the remote host
   * through the exact runner SessionManager uses.
   */
  async start(userId: number, sessionId: number): Promise<TerminalState> {
    const s = this.mustOwn(userId, sessionId);
    const hostId = this.app.sessions.currentHostId;
    const tmux = this.app.sessions.tmuxTransport;

    let t = this.terms.get(sessionId);
    if (t && t.hostId !== hostId) {
      // The active server changed underneath us — the old shell lives on a
      // transport we no longer speak to. Forget it and open a fresh one.
      this.terms.delete(sessionId);
      t = undefined;
    }
    if (t) {
      t.lastUsedMs = Date.now();
      this.ensurePolling(sessionId, t);
      this.ensureGc();
      return this.status(sessionId);
    }
    if (!(await tmux.available()))
      throw new Error("tmux is not available on this server — interactive terminal needs it.");

    const name = `term-${sessionId}`;
    // Reuse a shell that survived a TeleOps restart — but only a LIVE one:
    // with remain-on-exit a dead pane still exists, and reopening must not
    // resurrect an exited shell as a "connected" terminal.
    if (await tmux.exists(name)) {
      if (!(await tmux.isAlive(name))) await tmux.killSession(name);
    }
    if (!(await tmux.exists(name))) await tmux.newSession(name, s.cwd);
    t = {
      name,
      cwd: s.cwd,
      hostId,
      lastOutput: "",
      lastUsedMs: Date.now(),
      pollTimer: null,
    };
    this.terms.set(sessionId, t);
    this.hub.append(sessionId, "system", `terminal opened in ${s.cwd}`, true);
    this.ensurePolling(sessionId, t);
    this.ensureGc();
    return this.status(sessionId);
  }

  /** Literal text + Enter — delivered to the SHELL pane only. */
  async sendText(userId: number, sessionId: number, text: string): Promise<void> {
    const t = this.mustBeLive(userId, sessionId);
    await this.assertNotExited(sessionId, t);
    if (!text) return;
    if (text.length > 4000) throw new Error("Input too long (max 4000 characters).");
    t.lastUsedMs = Date.now();
    this.ensurePolling(sessionId, t);
    await this.app.sessions.tmuxTransport.sendInput(t.name, text);
    // NO local echo: the pane capture diff is the single source of truth,
    // so the command line appears exactly once, with the shell's own result.
  }

  /** Special keys (Ctrl+C etc.) from a fixed allowlist — never arbitrary names. */
  async sendKey(userId: number, sessionId: number, key: string): Promise<void> {
    const t = this.mustBeLive(userId, sessionId);
    if (!ALLOWED_KEYS.has(key))
      throw new Error(`Key "${key}" is not allowed.`);
    await this.assertNotExited(sessionId, t);
    t.lastUsedMs = Date.now();
    this.ensurePolling(sessionId, t);
    await this.app.sessions.tmuxTransport.sendKey(t.name, key);
  }

  /** Input never goes to a shell that has already exited. */
  private async assertNotExited(sessionId: number, t: Term): Promise<void> {
    if (await this.app.sessions.tmuxTransport.isAlive(t.name)) return;
    this.kill(sessionId);
    throw new Error("The terminal shell has exited — reopen the terminal.");
  }

  async stop(userId: number, sessionId: number): Promise<void> {
    this.mustOwn(userId, sessionId);
    this.kill(sessionId);
  }

  /**
   * Internal removal for callers that already enforced ownership (the
   * SessionManager deletion hook) — kills the shell if one is open.
   */
  drop(sessionId: number): void {
    this.kill(sessionId);
  }

  private mustBeLive(userId: number, sessionId: number): Term {
    this.mustOwn(userId, sessionId);
    const t = this.terms.get(sessionId);
    if (!t) throw new Error("Terminal is not open — start it first.");
    if (t.hostId !== this.app.sessions.currentHostId)
      throw new Error("The active server changed — close and reopen the terminal.");
    return t;
  }

  private kill(sessionId: number): void {
    const t = this.terms.get(sessionId);
    if (!t) return;
    if (t.pollTimer) clearInterval(t.pollTimer);
    this.terms.delete(sessionId);
    if (t.hostId === this.app.sessions.currentHostId) {
      void this.app.sessions.tmuxTransport
        .killSession(t.name)
        .catch(() => undefined);
    }
    this.hub.append(sessionId, "system", "terminal closed", true);
  }

  /** Keep polling cheap: pause when nobody interacts, reap long-idle shells. */
  private ensurePolling(sessionId: number, t: Term): void {
    if (t.pollTimer) return;
    t.pollTimer = setInterval(() => {
      void this.poll(sessionId).catch(() => undefined);
    }, POLL_MS);
    t.pollTimer.unref?.();
  }

  private async poll(sessionId: number): Promise<void> {
    const t = this.terms.get(sessionId);
    if (!t) return;
    const now = Date.now();
    if (now - t.lastUsedMs > POLL_IDLE_MS && this.hub.subscriberCount(sessionId) === 0) {
      if (t.pollTimer) {
        clearInterval(t.pollTimer);
        t.pollTimer = null;
      }
      return;
    }
    const output = await this.app.sessions.tmuxTransport.capturePane(t.name, 250);
    if (!(await this.app.sessions.tmuxTransport.isAlive(t.name))) {
      // The shell exited (e.g. `exit`, or the host went down): drain whatever
      // the dead pane still shows, then tear the terminal down. A terminal
      // must NEVER keep looking live with no process behind it.
      const chunk = outputDelta(t.lastOutput, output);
      if (chunk.trim()) this.hub.append(sessionId, "shell", chunk, true);
      this.hub.append(sessionId, "system", "shell process exited — terminal closed", true);
      this.kill(sessionId);
      return;
    }
    // Prefix/scroll/redraw-safe diff: appended lines, scrolled remainder and
    // in-place redraws each produce ONLY the real change — no duplicated
    // screen-fulls when tmux wraps or repaints.
    const chunk = outputDelta(t.lastOutput, output);
    t.lastOutput = output;
    if (chunk.trim()) this.hub.append(sessionId, "shell", chunk, true);
  }

  private ensureGc(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, t] of [...this.terms]) {
        if (now - t.lastUsedMs > TERM_GC_MS) this.kill(id);
      }
      if (!this.terms.size && this.gcTimer) {
        clearInterval(this.gcTimer);
        this.gcTimer = null;
      }
    }, 60_000);
    this.gcTimer.unref?.();
  }

  /** Close every shell's timers without killing panes (TeleOps shutdown). */
  shutdown(): void {
    for (const [, t] of this.terms) {
      if (t.pollTimer) clearInterval(t.pollTimer);
    }
    this.terms.clear();
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }
}

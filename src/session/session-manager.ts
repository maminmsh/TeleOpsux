import { DB } from "../db/database";
import { EventBus } from "../core/event-bus";
import { Tmux } from "./tmux";
import { AdapterRegistry } from "../adapters/registry";
import { LogHub } from "../logger/logger";
import { Config } from "../config/config";
import { assertTransition, ACTIVE_STATUSES } from "./state-machine";
import { ProjectFiles } from "./project-files";
import type { ExecRunner } from "../exec/exec-runner";
import { LocalRunner } from "../exec/local-runner";
import type { ModuleErrorTracker } from "../core/error-tracker";
import { tailLines } from "../adapters/base-adapter";
import { redactSecrets } from "../auth/access";
import type { CreateSessionOptions } from "../adapters/agent-adapter";
import {
  CredentialRequiredError,
  CredentialService,
  CREDENTIAL_IN_CHAT_MESSAGE,
} from "../credentials/credential-service";
import {
  stageCredentialFile,
  removeCredentialFile,
} from "../credentials/launch-staging";
import {
  SessionRecord,
  SessionStatus,
} from "../shared/types";

/**
 * The genuinely-new text between two capturePane snapshots. A pane capture is a
 * SCROLLING window, so the previous snapshot is NOT a prefix of the next — a
 * naive `next.slice(prev.length)` re-emits old lines every time the pane
 * scrolls (the source of duplicated output at the event layer). Strategy:
 * identical → ""; plain append → the tail; scrolled window → the suffix/prefix
 * overlap between the two windows; redraw-only (spinner/status line) → the
 * positional line diff, which re-emits only the lines that actually changed.
 */
export function outputDelta(prev: string, next: string): string {
  if (prev === next) return "";
  if (!prev.length) return next;
  if (next.startsWith(prev)) return next.slice(prev.length);
  const p = prev.split("\n");
  const n = next.split("\n");
  const max = Math.min(p.length, n.length);
  for (let k = max; k >= 1; k--) {
    let overlap = true;
    for (let i = 0; i < k; i++) {
      if (p[p.length - k + i] !== n[i]) {
        overlap = false;
        break;
      }
    }
    if (overlap) return n.slice(k).join("\n");
  }
  const changed: string[] = [];
  for (let i = 0; i < n.length; i++) {
    const line = n[i] as string;
    if (line !== p[i]) changed.push(line);
  }
  return changed.join("\n");
}

interface Runtime {
  startedAtMs: number;
  lastActivityMs: number;
  lastOutput: string;
  status: SessionStatus;
  idleReported: boolean;
  credentialReported: boolean;
}

export interface CreateSessionParams {
  name: string;
  project_id: number | null;
  agent: string;
  /**
   * Working directory ON THE SESSION'S HOST (absolute remote path when an
   * SSH host is attached). With a host attached this is overridden by the
   * registered project root.
   */
  cwd: string;
  task?: string;
  branch?: string;
  /**
   * Set when the UI layer already VALIDATED `cwd` against the active
   * transport (canonical `pwd -P`, inside the user's own home) — e.g. a
   * directory picked in the Mini App browser. Remote mode then honours this
   * cwd instead of demanding a registered project.
   */
  cwd_trusted?: boolean;
  /** Telegram user that owns the session. NULL only for legacy/system rows. */
  owner_telegram_user_id?: number | null;
}

export interface HostDeps {
  hostId: number;
  runner: ExecRunner;
  tmux: Tmux;
  projectFiles: ProjectFiles;
}

const TERMINAL_STATUSES: SessionStatus[] = ["STOPPED", "FINISHED", "CRASHED"];

/**
 * Session Manager — the most important component (docs §23.2). It owns the
 * lifecycle of persistent tmux-backed agent sessions, captures output,
 * classifies status, drives heartbeats and emits domain events. It has no
 * knowledge of Telegram; the UI layer subscribes to its events.
 */
export class SessionManager {
  private runtime = new Map<number, Runtime>();
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private host: HostDeps | null = null;
  private tracker: ModuleErrorTracker | null = null;
  private localTmux: Tmux;
  private readonly localRunner = new LocalRunner();
  private runner: ExecRunner = this.localRunner;
  private creds: CredentialService | null = null;

  constructor(
    private db: DB,
    private bus: EventBus,
    private tmux: Tmux,
    private adapters: AdapterRegistry,
    private logs: LogHub,
    private config: Config,
  ) {
    this.localTmux = tmux;
  }

  /** Swap in the SSH transport (or null to go back to local). Hot-swappable at runtime. */
  attachHost(deps: HostDeps | null): void {
    this.host = deps;
    this.tmux = deps?.tmux ?? this.localTmux;
    this.runner = deps?.runner ?? this.localRunner;
  }

  setTracker(tracker: ModuleErrorTracker): void {
    this.tracker = tracker;
  }

  /**
   * Per-user credential store. Without it, any agent declaring
   * `credentialEnvVar` FAILS CLOSED (no shared server login fallback).
   */
  setCredentials(creds: CredentialService): void {
    this.creds = creds;
  }

  /**
   * A credential is never allowed into chat history, task text or the agent
   * pane — reject input that contains one (also blocks pasting someone else's).
   */
  private assertNoCredentialInText(text: string | undefined): void {
    if (text && this.creds?.containsStoredSecret(text))
      throw new Error(CREDENTIAL_IN_CHAT_MESSAGE);
  }

  get remoteMode(): boolean {
    return this.host !== null;
  }

  /**
   * The CURRENT tmux transport (follows attachHost hot-swap). The live
   * terminal Mini App opens its shells through this so a remote-host project
   * can never accidentally run commands on the TeleOps control server.
   */
  get tmuxTransport(): Tmux {
    return this.tmux;
  }

  /** Active host id, or null in local mode — terminal binding check. */
  get currentHostId(): number | null {
    return this.host?.hostId ?? null;
  }

  /** Whether the tmux binary is reachable on the current transport. */
  async tmuxAvailable(): Promise<boolean> {
    return this.tmux.available();
  }

  private activeCount(): number {
    return this.db
      .listSessions()
      .filter((s) =>
        ["STARTING", "WORKING", "WAITING_INPUT", "WAITING_APPROVAL"].includes(
          s.status,
        ),
      ).length;
  }

  async create(params: CreateSessionParams): Promise<SessionRecord> {
    this.assertNoCredentialInText(params.task);
    const adapter = this.adapters.get(params.agent);
    if (!adapter)
      throw new Error(`Agent "${params.agent}" is not available.`);

    // fail-closed: an agent that declares credentialEnvVar runs ONLY with the
    // owning user's own credential — never a shared server key/login
    if (
      adapter.credentialEnvVar &&
      !this.creds?.hasCredential(params.owner_telegram_user_id ?? null)
    )
      throw new CredentialRequiredError();

    let cwd = params.cwd;
    if (this.host && !params.cwd_trusted) {
      // Remote mode without a browser-validated cwd: sessions may only run
      // inside registered projects of the active host, and the cwd always
      // comes from the DB row, never from the caller.
      const project =
        params.project_id !== null ? this.db.getProject(params.project_id) : undefined;
      if (!project || project.host_id !== this.host.hostId)
        throw new Error(
          "Sessions must run in a registered project of the active server. Use /addproject.",
        );
      cwd = project.root;
    } else if (this.host && params.cwd_trusted) {
      if (!params.cwd.startsWith("/") || params.cwd.length < 2)
        throw new Error("Trusted cwd must be an absolute path on the active server.");
      cwd = params.cwd;
    }

    if (this.activeCount() >= this.config.sessions.max_concurrent)
      throw new Error(
        `Max concurrent sessions (${this.config.sessions.max_concurrent}) reached.`,
      );

    const session = this.db.createSession({
      name: params.name,
      project_id: params.project_id,
      agent_type: params.agent,
      cwd,
      owner_telegram_user_id: params.owner_telegram_user_id ?? null,
    });
    this.db.updateSession(session.id, {
      terminal_id: String(session.id),
      branch: params.branch ?? null,
    });
    this.bus.emit({
      type: "SESSION_CREATED",
      session_id: session.id,
      payload: { name: session.name, agent: params.agent, cwd },
    });
    return this.db.getSession(session.id)!;
  }

  async start(sessionId: number, task?: string): Promise<SessionRecord> {
    this.assertNoCredentialInText(task);
    const session = this.mustGet(sessionId);
    const adapter = this.adapters.get(session.agent_type);
    if (!adapter) throw new Error(`No adapter for ${session.agent_type}`);

    const needsCred = Boolean(adapter.credentialEnvVar);
    if (needsCred && !this.creds?.hasCredential(session.owner_telegram_user_id))
      throw new CredentialRequiredError();

    // Idempotent restart: while a live agent pane already exists, a repeated
    // start (double-tap, resume race) must NOT spawn a second process or
    // re-emit the "agent started" lifecycle line.
    if (
      this.runtime.has(sessionId) &&
      ACTIVE_STATUSES.includes(session.status) &&
      (await this.tmux.isAlive(String(sessionId)))
    )
      return this.mustGet(sessionId);

    if (!(await this.tmux.available()))
      throw new Error(
        "tmux is not installed — persistent sessions require tmux. Install it and retry.",
      );

    // Restart is only legal from CREATED/STOPPED/FINISHED/CRASHED. If a live-
    // looking status (WORKING/ERROR/…) has NO alive pane behind it (crash the
    // poller hasn't observed yet, or resume() of a dead pane), reflect reality
    // by dropping to STOPPED first, then STARTING is valid.
    if (
      !["CREATED", "STOPPED", "FINISHED", "CRASHED", "STARTING"].includes(session.status)
    )
      this.db.setStatus(sessionId, "STOPPED");

    this.transition(sessionId, "STARTING");
    const name = String(sessionId);
    let secretFilePath: string | undefined;
    try {
      // LAUNCH PREFLIGHT: resolve the agent executable ON THE SESSION HOST
      // before anything is declared started. The resolved ABSOLUTE path is used
      // for the pane command, so the tmux server's differing PATH can never
      // produce "sh: 1: exec: qoder: not found" inside a live interactive shell.
      let resolvedCommand: string | undefined;
      if (adapter.executable) {
        const res = await this.preflightExecutable(adapter.executable);
        if (!res.ok) return this.failStart(sessionId, res.error);
        resolvedCommand = res.path;
      }

      // clear a dead remain-on-exit pane from a previous attempt before restart
      if ((await this.tmux.exists(name)) && !(await this.tmux.isAlive(name)))
        await this.tmux.killSession(name);

      const opts: CreateSessionOptions = {
        cwd: session.cwd,
        project: session.name,
        task: task ?? undefined,
        resolvedCommand,
      };
      if (!(await this.tmux.exists(name))) {
        if (needsCred) {
          const uid = session.owner_telegram_user_id!;
          const key = this.creds!.revealForLaunch(uid);
          if (!key) {
            this.creds!.markInvalid(uid);
            throw new CredentialRequiredError();
          }
          secretFilePath = this.credentialFilePath(sessionId);
          await stageCredentialFile(this.runner, secretFilePath, key);
          opts.secretFilePath = secretFilePath;
        }
        // the launch command IS the pane command — when the agent dies, the
        // pane dies with it; nothing survives to swallow later input
        await this.tmux.newSession(name, session.cwd, adapter.launchCommand(opts));
        await this.setupTaskLog(session, task);
      }

      // WORKING is reported only after the process survived the immediate-
      // failure window. remain-on-exit keeps a crashed pane's FINAL output and
      // exit code readable, so the real error is surfaced, never guessed.
      await new Promise((r) => setTimeout(r, SessionManager.STARTUP_VERIFY_MS));
      let pane = await this.tmux.paneStatus(name);
      if (!pane || pane.dead) {
        const out = await this.tmux.capturePane(name, 60);
        return this.failStart(
          sessionId,
          `the ${adapter.name} process exited immediately` +
            (pane?.exitCode != null ? ` (exit code ${pane.exitCode})` : "") +
            (out.trim() ? ` — last output: ${this.scrubTail(out)}` : " — it produced no output"),
          { output: out, secretFilePath },
        );
      }
      this.db.updateSession(sessionId, { pid: pane.pid });

      const initial = adapter.initialInput?.(opts);
      if (initial) {
        // give the TUI a moment to render before typing the task
        await new Promise((r) => setTimeout(r, 1500));
        pane = await this.tmux.paneStatus(name);
        if (!pane || pane.dead) {
          const out = await this.tmux.capturePane(name, 60);
          return this.failStart(
            sessionId,
            `the ${adapter.name} process exited before receiving the task` +
              (out.trim() ? ` — last output: ${this.scrubTail(out)}` : ""),
            { output: out, secretFilePath },
          );
        }
        await this.tmux.sendInput(name, initial);
        this.db.addMessage({
          session_id: sessionId,
          direction: "USER_TO_AGENT",
          content: initial,
          source: "telegram",
        });
      }

      this.transition(sessionId, "WORKING");
      this.runtime.set(sessionId, {
        startedAtMs: Date.now(),
        lastActivityMs: Date.now(),
        lastOutput: "",
        status: "WORKING",
        idleReported: false,
        credentialReported: false,
      });
      this.bus.emit({ type: "SESSION_STARTED", session_id: sessionId });
      this.ensurePolling();
      return this.mustGet(sessionId);
    } catch (e) {
      if (secretFilePath) await removeCredentialFile(this.runner, secretFilePath);
      if (this.db.getSession(sessionId)?.status === "STARTING") {
        // a frozen STARTING is as misleading as a false WORKING — record why
        this.db.updateSession(sessionId, {
          waiting_reason: String((e as Error).message).slice(0, 500),
        });
        this.safeTransition(sessionId, "ERROR");
        this.runtime.delete(sessionId);
      }
      throw e;
    }
  }

  /** Milliseconds to wait for an instant spawn failure before declaring WORKING. */
  private static readonly STARTUP_VERIFY_MS = 900;

  /**
   * Record a REAL startup failure: persist the actionable message (never a
   * fake WORKING), keep the session + diagnostics for inspection, clean the
   * staged credential and the dead pane, notify, then throw the same message
   * so the calling UI shows it directly.
   */
  private failStart(
    sessionId: number,
    message: string,
    opts: { output?: string; secretFilePath?: string } = {},
  ): never {
    if (opts.secretFilePath)
      void removeCredentialFile(this.runner, opts.secretFilePath);
    const patch: Parameters<DB["updateSession"]>[1] = { waiting_reason: message.slice(0, 500) };
    if (opts.output && opts.output.trim()) patch.last_output = opts.output.slice(-4000);
    this.db.updateSession(sessionId, patch);
    this.safeTransition(sessionId, "ERROR");
    this.runtime.delete(sessionId);
    void this.tmux.killSession(String(sessionId)).catch(() => undefined);
    this.bus.emit({
      type: "PROCESS_CRASHED",
      session_id: sessionId,
      severity: "CRITICAL",
      payload: { reason: message },
    });
    throw new Error(message);
  }

  /**
   * Resolve the agent executable on the CURRENT session host (local FS or the
   * attached SSH host). A login shell gives the richest PATH; the ABSOLUTE
   * path returned is what the pane then execs — the pane itself never relies
   * on PATH. The binary name comes from operator config (never user text) and
   * is passed as an ARGUMENT, so it cannot inject shell syntax.
   * Public: the personal terminal preflights `qoder` through this exact path
   * so a terminal-typed `qoder` behaves identically to a managed session.
   */
  async preflightExecutable(
    command: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    // MUST run on the same transport the pane will be created on — that is
    // where PATH matters (and what the unit-test fakes intercept).
    const r = await this.tmux.execRunner.exec(
      "sh",
      ["-lc", 'command -v "$1"', "teleops-preflight", command],
      { timeoutMs: 20_000 },
    );
    const path = (r.stdout || "").split("\n")[0]?.trim() ?? "";
    if (r.code === 0 && path.startsWith("/")) return { ok: true, path };
    const host = this.host ? "the active server" : "this machine";
    const detail = (r.stderr || "").trim().slice(0, 160);
    return {
      ok: false,
      error:
        `"${command}" was not found on ${host}, so the agent cannot start. ` +
        "Install it, or point agents.<id>.command (env QODER_BIN for Qoder) at its absolute path. " +
        "Note: tmux panes do not inherit an interactive login PATH, so a binary that works " +
        "when you SSH in can still be missing here." +
        (detail ? ` Details: ${detail}` : ""),
    };
  }

  /** Short, secret-safe excerpt of pane output for error messages. */
  private scrubTail(output: string): string {
    const line =
      tailLines(output, 8)
        .filter((l) => l.trim())
        .slice(-2)
        .join(" / ") || "(empty)";
    const safe = redactSecrets(line);
    return (this.creds ? this.creds.redactAll(safe) : safe).slice(0, 300);
  }

  async stop(sessionId: number): Promise<void> {
    const session = this.mustGet(sessionId);
    if (session.status === "STOPPED" || session.status === "FINISHED") return;
    this.transition(sessionId, "STOPPING");
    await this.tmux.killSession(String(sessionId));
    this.transition(sessionId, "STOPPED");
    this.runtime.delete(sessionId);
    // best-effort: a crashed launch may have left the staged key on disk
    await removeCredentialFile(this.runner, this.credentialFilePath(sessionId));
    this.bus.emit({ type: "SESSION_STOPPED", session_id: sessionId });
  }

  /** UI-layer cleanups to run when a session is deleted (shell panes, rings). */
  private deletionHooks: ((sessionId: number) => void)[] = [];
  onDeleted(fn: (sessionId: number) => void): void {
    this.deletionHooks.push(fn);
  }

  /**
   * THE delete path for every UI (Telegram bot and Mini App alike):
   * best-effort agent stop (dead/crashed statuses have no legal STOPPING
   * transition), then remove the row plus all stored history, then let the
   * web layers drop their per-session state. Ownership checks are the
   * CALLER's job — this method trusts them.
   */
  async remove(sessionId: number): Promise<void> {
    try {
      await this.stop(sessionId);
    } catch {
      /* not transitionable or transport already gone — nothing left to kill;
         deletion must still proceed so the user is never stuck */
    }
    this.db.deleteSession(sessionId);
    for (const fn of this.deletionHooks) fn(sessionId);
  }

  async resume(sessionId: number): Promise<SessionRecord> {
    const session = this.mustGet(sessionId);
    const name = String(sessionId);
    // isAlive (not exists): with remain-on-exit a dead pane still EXISTS —
    // only a not-dead pane means the agent is actually still running.
    if (await this.tmux.isAlive(name)) {
      // tmux session still alive — reconnect bookkeeping only
      const pid = await this.tmux.panePid(name);
      this.db.updateSession(sessionId, { pid });
      this.reconnect(sessionId, pid);
      return this.mustGet(sessionId);
    }
    return this.start(sessionId);
  }

  async sendInput(sessionId: number, text: string): Promise<void> {
    this.assertNoCredentialInText(text);
    const session = this.mustGet(sessionId);
    // AGENT CHAT is for the agent — never for a shell. If no live agent
    // process is behind this session, the message is REFUSED instead of being
    // typed into some surviving pane where it would run as a Linux command.
    const ACCEPTS_INPUT: SessionStatus[] = [
      "STARTING",
      "WORKING",
      "WAITING_INPUT",
      "WAITING_APPROVAL",
      "ERROR",
    ];
    if (!ACCEPTS_INPUT.includes(session.status))
      throw new Error(
        `Session #${sessionId} is ${session.status} — resume/restart it before sending messages.`,
      );
    if (!(await this.tmux.isAlive(String(sessionId))))
      throw new Error(
        `The agent in session #${sessionId} is no longer running — resume/restart it before sending messages.`,
      );
    await this.tmux.sendInput(String(sessionId), text);
    this.db.addMessage({
      session_id: sessionId,
      direction: "USER_TO_AGENT",
      content: text,
      source: "telegram",
    });
    const rt = this.runtime.get(sessionId);
    if (rt) {
      rt.lastActivityMs = Date.now();
      rt.idleReported = false;
    }
    // any user reply moves WAITING/ERROR back to WORKING
    if (
      session.status === "WAITING_INPUT" ||
      session.status === "WAITING_APPROVAL" ||
      session.status === "ERROR"
    ) {
      this.transition(sessionId, "WORKING");
    }
  }

  async sendKey(sessionId: number, key: string): Promise<void> {
    const session = this.mustGet(sessionId);
    if (!(await this.tmux.isAlive(String(sessionId))))
      throw new Error(
        `The process in session #${sessionId} is no longer running.`,
      );
    await this.tmux.sendKey(String(sessionId), key);
    const rt = this.runtime.get(sessionId);
    if (rt) {
      rt.lastActivityMs = Date.now();
      rt.idleReported = false;
    }
  }

  async resize(sessionId: number, cols: number, rows: number): Promise<void> {
    const session = this.mustGet(sessionId);
    if (await this.tmux.exists(String(sessionId))) {
      await this.tmux.resizePane(String(sessionId), cols, rows);
    }
  }

  async capture(sessionId: number, lines = 200): Promise<string> {
    return this.tmux.capturePane(String(sessionId), lines);
  }

  async status(sessionId: number): Promise<SessionStatus> {
    return this.mustGet(sessionId).status;
  }

  summary(sessionId: number) {
    const session = this.mustGet(sessionId);
    const adapter = this.adapters.get(session.agent_type);
    const rt = this.runtime.get(sessionId);
    const output = rt?.lastOutput ?? session.last_output ?? "";
    const startedAtMs = rt?.startedAtMs ?? Date.parse(session.created_at);
    return adapter?.summarize(output, { startedAtMs }) ?? null;
  }

  private mustGet(id: number): SessionRecord {
    const s = this.db.getSession(id);
    if (!s) throw new Error(`Session #${id} not found`);
    return s;
  }

  /**
   * Path of the one-shot credential file for a session, on the SESSION HOST
   * (local FS in local mode, remote FS over SSH). Derived from the numeric
   * session id only — never from user text. Returned UNQUOTED; every use site
   * wraps it in double quotes so a `$HOME` containing spaces stays one word.
   */
  private credentialFilePath(sessionId: number): string {
    return `$HOME/.teleops-credentials/teleops-session-${sessionId}.key`;
  }

  /** Best-effort: create .teleops/logs file (via pipe-pane) + task_logs row + memory entry. */
  private async setupTaskLog(session: SessionRecord, task?: string): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logPath = `${host.projectFiles.logDir(session.cwd)}/${stamp}-session-${session.id}.log`;
      await host.projectFiles.ensureLogDir(session.cwd);
      const piped = await this.tmux.pipePane(
        String(session.id),
        Tmux.appendToShell(logPath),
      );
      if (!piped)
        this.tracker?.report("session", "pipe-pane unavailable — file logging disabled", {
          session_id: session.id,
        });
      this.db.updateSession(session.id, { log_path: piped ? logPath : null });
      this.db.createTaskLog({
        session_id: session.id,
        project_id: session.project_id,
        remote_path: logPath,
        task: task ?? null,
        status: "STARTED",
      });
      await host.projectFiles.upsertMemory(session.cwd, {
        session_id: session.id,
        agent: session.agent_type,
        task: (task ?? "").slice(0, 300),
        status: "STARTED",
        summary: "",
      });
    } catch (e) {
      this.tracker?.report("session", e, { session_id: session.id, step: "setupTaskLog" });
    }
  }

  /** Close the open task_logs row and update the project memory entry. */
  private async finalizeTaskLog(sessionId: number, status: SessionStatus): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      const session = this.db.getSession(sessionId);
      if (!session) return;
      const log = this.db.listTaskLogs({ session_id: sessionId }, 1)[0];
      if (log && !log.ended_at) {
        const size = session.log_path
          ? await host.projectFiles.fileSize(session.log_path)
          : null;
        this.db.closeTaskLog(log.id, status, size ?? undefined);
      }
      const rt = this.runtime.get(sessionId);
      const adapter = this.adapters.get(session.agent_type);
      const output = rt?.lastOutput ?? session.last_output ?? "";
      let summary = "";
      if (adapter && output.trim()) {
        try {
          const s = adapter.summarize(output, {
            startedAtMs: rt?.startedAtMs ?? Date.parse(session.created_at),
          });
          summary =
            s.completed.length > 0
              ? `done: ${s.completed.slice(-2).join("; ")}`.slice(0, 200)
              : (s.current || "").slice(0, 200);
        } catch {
          /* summary is cosmetic */
        }
      }
      await host.projectFiles.upsertMemory(session.cwd, {
        session_id: sessionId,
        status,
        summary,
      });
    } catch (e) {
      this.tracker?.report("session", e, { session_id: sessionId, step: "finalizeTaskLog" });
    }
  }

  private transition(id: number, to: SessionStatus): void {
    const from = this.mustGet(id).status;
    assertTransition(from, to);
    this.db.setStatus(id, to);
    const rt = this.runtime.get(id);
    if (rt) rt.status = to;
    if (to === "WORKING")
      this.bus.emit({ type: "AGENT_WORKING", session_id: id });
    if (TERMINAL_STATUSES.includes(to))
      void this.finalizeTaskLog(id, to).catch(() => {});
  }

  private reconnect(id: number, pid: number | null): void {
    this.runtime.set(id, {
      startedAtMs: Date.now(),
      lastActivityMs: Date.now(),
      lastOutput: "",
      status: "WORKING",
      idleReported: false,
      credentialReported: false,
    });
    this.db.setStatus(id, "WORKING");
    this.bus.emit({
      type: "SESSION_RECONNECTED",
      session_id: id,
      payload: { pid },
    });
  }

  /** On boot, recover sessions that still have a live tmux pane (docs §61). */
  async recover(): Promise<void> {
    if (!(await this.tmux.available())) return;
    for (const s of this.db.listSessions()) {
      // a dead remain-on-exit pane is NOT "live" — isAlive checks the process
      const live = await this.tmux.isAlive(String(s.id));
      if (
        live &&
        ["STARTING", "WORKING", "WAITING_INPUT", "WAITING_APPROVAL"].includes(
          s.status,
        )
      ) {
        const pid = await this.tmux.panePid(String(s.id));
        this.db.updateSession(s.id, { pid });
        this.reconnect(s.id, pid);
      } else if (!live && s.status !== "STOPPED" && s.status !== "FINISHED") {
        // A STARTING session may be mid-boot right now (start() races the
        // deferred recover on first SSH connect) — don't declare it dead yet.
        const ageMs = Date.now() - Date.parse(s.updated_at + (s.updated_at.includes("T") ? "" : "Z"));
        if (s.status === "STARTING" && Number.isFinite(ageMs) && ageMs < 60_000) continue;
        // not recovered — process gone (docs §61)
        this.db.setStatus(s.id, "STOPPED");
        void this.finalizeTaskLog(s.id, "STOPPED").catch(() => {});
        this.bus.emit({
          type: "PROCESS_CRASHED",
          session_id: s.id,
          payload: { reason: "process not found on restart" },
          severity: "WARNING",
        });
      }
    }
    this.ensurePolling();
  }

  /** Reconcile database state with active tmux panes and runtime registry. */
  async reconcile(): Promise<{ sessions: number; active: number }> {
    await this.recover();
    const all = this.db.listSessions();
    const active = all.filter((s) =>
      ["STARTING", "WORKING", "WAITING_INPUT", "WAITING_APPROVAL"].includes(s.status),
    ).length;
    return { sessions: all.length, active };
  }

  private ensurePolling(): void {
    if (this.pollTimer || this.runtime.size === 0) return;
    const interval =
      Math.max(1, this.config.sessions.heartbeat_interval_seconds) * 1000;
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, interval);
    this.pollTimer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const [id, rt] of [...this.runtime]) {
        // one throwing session must not stall inspection of the others
        try {
          await this.inspect(id, rt);
        } catch (e) {
          this.tracker?.report("session", e, { session_id: id, step: "inspect" });
        }
      }
    } finally {
      this.polling = false;
    }
    if (this.runtime.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async inspect(id: number, rt: Runtime): Promise<void> {
    const session = this.db.getSession(id);
    if (!session) {
      this.runtime.delete(id);
      return;
    }
    const adapter = this.adapters.get(session.agent_type);
    if (!adapter) return;

    // A pane that still EXISTS but has exited (remain-on-exit) is process
    // death just like a vanished session — treat both as "not alive".
    const pane = await this.tmux.paneStatus(String(id));
    const alive = pane !== null && !pane.dead;
    if (!alive) {
      if (rt.status !== "STOPPED" && rt.status !== "FINISHED") {
        // drain the exited pane's final output (still readable) before ending
        const out = await this.tmux.capturePane(String(id), 250);
        const diff = outputDelta(rt.lastOutput, out);
        if (diff.trim()) {
          this.logs.session.sessionOutput(id, diff.trim());
          this.db.updateSession(id, { last_output: out.slice(-4000) });
          this.bus.emit({
            type: "SESSION_OUTPUT",
            session_id: id,
            payload: { chunk: diff.slice(-2000) },
          });
        }
        this.safeTransition(id, "CRASHED");
        this.bus.emit({
          type: "PROCESS_CRASHED",
          session_id: id,
          severity: "CRITICAL",
          payload: { reason: pane?.dead ? `process exited (code ${pane.exitCode ?? "?"})` : "process not found" },
        });
        this.runtime.delete(id);
        await this.tmux.killSession(String(id)).catch(() => undefined);
      }
      return;
    }

    const output = await this.tmux.capturePane(String(id), 250);
    const changed = output !== rt.lastOutput;
    if (changed) {
      // prefix-safe: capture-pane is a scrolling window, so a plain length-
      // slice re-emits scrolled-off lines (the duplication bug). outputDelta
      // emits only what genuinely changed.
      const diff = outputDelta(rt.lastOutput, output);
      if (diff.trim()) this.logs.session.sessionOutput(id, diff.trim());
      rt.lastOutput = output;
      rt.lastActivityMs = Date.now();
      rt.idleReported = false;
      this.db.updateSession(id, {
        last_output: output.slice(-4000),
      });
      if (diff.trim())
        this.bus.emit({
          type: "SESSION_OUTPUT",
          session_id: id,
          payload: { chunk: diff.slice(-2000) },
        });
    }

    const next = adapter.classifyStatus(output, true);

    // auth failures are a CREDENTIAL problem, not a task problem: mark the
    // owner's credential invalid (status only — the value is never logged)
    if (!rt.credentialReported && adapter.detectCredentialError?.(output)) {
      rt.credentialReported = true;
      const uid = session.owner_telegram_user_id;
      if (uid != null) {
        this.creds?.markInvalid(uid);
        this.bus.emit({
          type: "CREDENTIAL_INVALID",
          session_id: id,
          payload: { status: "invalid", agent: session.agent_type },
          severity: "WARNING",
        });
      }
    }

    // idle detection: no new output for a long time while supposedly working
    const idleMs = Date.now() - rt.lastActivityMs;
    if (
      next === "WORKING" &&
      idleMs > this.config.sessions.idle_no_output_seconds * 1000 &&
      !rt.idleReported
    ) {
      rt.idleReported = true;
      this.bus.emit({
        type: "AGENT_WAITING",
        session_id: id,
        payload: { reason: "no output for a while" },
        severity: "WARNING",
      });
    }

    if (next !== rt.status) {
      const err = adapter.detectError(output);
      if (err) {
        this.bus.emit({
          type: err.kind === "test_failure" ? "TEST_FAILED" : "COMMAND_FAILED",
          session_id: id,
          payload: { detail: err.detail, kind: err.kind },
          severity: "ERROR",
        });
      }
      const waiting = adapter.detectWaiting(output);
      if (waiting) {
        this.safeTransition(id, next);
        if (waiting.kind === "approval") {
          this.db.updateSession(id, { waiting_reason: waiting.reason });
          this.bus.emit({
            type: "APPROVAL_REQUIRED",
            session_id: id,
            payload: { reason: waiting.reason },
            severity: "WARNING",
          });
        } else {
          this.db.updateSession(id, { waiting_reason: waiting.reason });
          this.bus.emit({
            type: "USER_INPUT_REQUIRED",
            session_id: id,
            payload: { question: waiting.reason },
            severity: "INFO",
          });
        }
      } else {
        this.safeTransition(id, next);
      }
      rt.status = next;
    }
  }

  private safeTransition(id: number, to: SessionStatus): void {
    const from = this.db.getSession(id)?.status;
    if (!from) return;
    try {
      this.transition(id, to);
    } catch {
      // illegal transition — set directly to keep runtime consistent
      this.db.setStatus(id, to);
      const rt = this.runtime.get(id);
      if (rt) rt.status = to;
      if (TERMINAL_STATUSES.includes(to))
        void this.finalizeTaskLog(id, to).catch(() => {});
    }
  }

  shutdown(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

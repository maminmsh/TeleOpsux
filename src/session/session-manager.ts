import { DB } from "../db/database";
import { EventBus } from "../core/event-bus";
import { Tmux } from "./tmux";
import { AdapterRegistry } from "../adapters/registry";
import { LogHub } from "../logger/logger";
import { Config } from "../config/config";
import { assertTransition } from "./state-machine";
import { ProjectFiles } from "./project-files";
import type { ExecRunner } from "../exec/exec-runner";
import { LocalRunner } from "../exec/local-runner";
import type { ModuleErrorTracker } from "../core/error-tracker";
import {
  CredentialRequiredError,
  CredentialService,
  CREDENTIAL_IN_CHAT_MESSAGE,
} from "../credentials/credential-service";
import {
  SessionRecord,
  SessionStatus,
} from "../shared/types";

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
    if (this.host) {
      // Remote mode: sessions may only run inside registered projects of the
      // active host; cwd always comes from the DB row, never from the caller.
      const project =
        params.project_id !== null ? this.db.getProject(params.project_id) : undefined;
      if (!project || project.host_id !== this.host.hostId)
        throw new Error(
          "Sessions must run in a registered project of the active server. Use /addproject.",
        );
      cwd = project.root;
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

    if (!(await this.tmux.available()))
      throw new Error(
        "tmux is not installed — persistent sessions require tmux. Install it and retry.",
      );

    this.transition(sessionId, "STARTING");
    const name = String(sessionId);

    if (!(await this.tmux.exists(name))) {
      let secretFilePath: string | undefined;
      if (needsCred) {
        const uid = session.owner_telegram_user_id!;
        const key = this.creds!.revealForLaunch(uid);
        if (!key) {
          this.creds!.markInvalid(uid);
          throw new CredentialRequiredError();
        }
        secretFilePath = this.credentialFilePath(sessionId);
        await this.stageCredentialFile(secretFilePath, key);
      }
      const opts = {
        cwd: session.cwd,
        project: session.name,
        task: task ?? undefined,
        secretFilePath,
      };
      try {
        await this.tmux.newSession(name, session.cwd, adapter.launchCommand(opts));
      } catch (e) {
        if (secretFilePath) await this.removeCredentialFile(secretFilePath);
        throw e;
      }
      await this.setupTaskLog(session, task);
    }

    const pid = await this.tmux.panePid(name);
    this.db.updateSession(sessionId, { pid });
    const opts = { cwd: session.cwd, project: session.name, task: task ?? undefined };
    const initial = adapter.initialInput?.(opts);
    if (initial) {
      // give the TUI a moment to render before typing the task
      await new Promise((r) => setTimeout(r, 1500));
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
  }

  async stop(sessionId: number): Promise<void> {
    const session = this.mustGet(sessionId);
    if (session.status === "STOPPED" || session.status === "FINISHED") return;
    this.transition(sessionId, "STOPPING");
    await this.tmux.killSession(String(sessionId));
    this.transition(sessionId, "STOPPED");
    this.runtime.delete(sessionId);
    // best-effort: a crashed launch may have left the staged key on disk
    await this.removeCredentialFile(this.credentialFilePath(sessionId));
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
    if (await this.tmux.exists(name)) {
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

  /**
   * Stage the owner's key into a 0600 file on the session host. The key is
   * written through the runner's STDIN channel (`input`) — it never appears in
   * argv, TeleOps process env, logs, or any output stream. The pane's launch
   * command reads and deletes the file at start.
   */
  private async stageCredentialFile(pathExpr: string, key: string): Promise<void> {
    const r = await this.runner.execScript(
      `umask 077 && mkdir -p "$(dirname "${pathExpr}")" && cat > "${pathExpr}" && chmod 600 "${pathExpr}"`,
      { input: key, timeoutMs: 20_000 },
    );
    if (r.code !== 0)
      throw new Error("could not stage the credential file on the session host");
  }

  private async removeCredentialFile(pathExpr: string): Promise<void> {
    try {
      await this.runner.execScript(`rm -f "${pathExpr}"`, { timeoutMs: 15_000 });
    } catch {
      /* best-effort cleanup */
    }
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
      const live = await this.tmux.exists(String(s.id));
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

    const alive = await this.tmux.exists(String(id));
    if (!alive) {
      if (rt.status !== "STOPPED" && rt.status !== "FINISHED") {
        this.safeTransition(id, "CRASHED");
        this.bus.emit({
          type: "PROCESS_CRASHED",
          session_id: id,
          severity: "CRITICAL",
        });
        this.runtime.delete(id);
      }
      return;
    }

    const output = await this.tmux.capturePane(String(id), 250);
    const changed = output !== rt.lastOutput;
    if (changed) {
      const diff = output.slice(rt.lastOutput.length);
      if (diff.trim()) this.logs.session.sessionOutput(id, diff.trim());
      rt.lastOutput = output;
      rt.lastActivityMs = Date.now();
      rt.idleReported = false;
      this.db.updateSession(id, {
        last_output: output.slice(-4000),
      });
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

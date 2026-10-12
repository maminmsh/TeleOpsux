import { Bot, InlineKeyboard, Context } from "grammy";
import { App } from "../core/container";
import { DomainEvent, SessionRecord } from "../shared/types";
import {
  ago,
  gitStatusText,
  processesList,
  serverStatus,
  serverStatusExtended,
  sessionsList,
} from "./format";
import { shq } from "../exec/exec-runner";
import { basename } from "../shared/paths";
import path from "node:path";
import {
  DENY_MESSAGE,
  canManageProject,
  effectiveActiveHostId,
  isAdminUser,
  isAllowedUser,
  projectVisibleTo,
  redactSecrets,
  resolveApproval,
  resolveHost,
  resolveProject,
  resolveSession,
  resolveTaskLog,
} from "../auth/access";
import { liveOutputTarget, notificationChatIds } from "../notify/routing";
import {
  CREDENTIAL_REQUIRED_MESSAGE,
  CredentialRequiredError,
} from "../credentials/credential-service";

interface Wizard {
  step: "project" | "agent" | "task";
  project_id?: number;
  agent?: string;
}

interface ServerWizard {
  step: "host" | "port" | "user" | "pass";
  draft: { host?: string; port?: number; username?: string };
}

interface UserState {
  activeSession?: number;
  wizard?: Wizard;
  serverWizard?: ServerWizard;
  projectWizard?: boolean;
  liveMessageId?: number;
  /** Waiting for the second tap on "delete my credential". */
  pendingKeyDelete?: boolean;
  /** "Set token" tapped — the next message is treated as the token. */
  pendingKeyEntry?: { promptMsgId: number };
  /** Per-user working directory for the restricted file commands. */
  shell?: { hostId: number; cwd: string };
}

/** Hard caps so a history/log dump can never exceed Telegram's 4096-char limit. */
const HISTORY_DEFAULT_LIMIT = 15;
const HISTORY_MAX_LIMIT = 30;
const LOGS_DEFAULT_LIMIT = 10;
const LOGS_MAX_LIMIT = 25;
const QODER_PAT_URL = "https://qoder.com/account/integrations";

/**
 * Telegram is a thin View Layer over the core (docs §53/§79). It never touches
 * the shell or tmux directly — everything routes through the Session Manager,
 * Git Manager, Approval and Policy layers. Access control is delegated to the
 * central auth layer (src/auth/access): every resource id coming from a
 * command argument or callback is re-resolved against the actor's ownership
 * before any action runs. Callback data is UNTRUSTED.
 */
export class TelegramController {
  private bot: Bot;
  private state = new Map<number, UserState>();
  private liveTimer?: NodeJS.Timeout;
  private liveState = new Map<number, string>();

  constructor(private app: App) {
    this.bot = new Bot(app.config.telegram.botToken);
    this.register();
  }

  // ---------- helpers ----------
  private allowed(ctx: Context): boolean {
    return isAllowedUser(this.app, ctx.from?.id);
  }

  private isAdmin(ctx: Context): boolean {
    return isAdminUser(this.app, ctx.from?.id);
  }

  /** Generic refusal — never reveals whether the resource exists. */
  private async deny(ctx: Context): Promise<void> {
    await ctx.reply(DENY_MESSAGE);
  }

  private async requireAdmin(ctx: Context): Promise<boolean> {
    if (this.isAdmin(ctx)) return true;
    await ctx.reply("⛔ This action is restricted to administrators.");
    return false;
  }

  /** Resolve a session id for the acting user; replies DENY when not permitted. */
  private ownedSession(ctx: Context, sessionId: number): SessionRecord | null {
    return resolveSession(this.app, ctx.from!.id, sessionId);
  }

  private st(userId: number): UserState {
    let s = this.state.get(userId);
    if (!s) {
      s = {};
      this.state.set(userId, s);
    }
    return s;
  }

  /**
   * "Open Session Terminal" button for the Live Mini App. Telegram's Bot API
   * does NOT let a bot open a Mini App by itself — the user taps this button.
   * The session id in the URL is only a NON-SECRET selector; the server
   * authorizes with initData + ownership on every call. When webapp.url is
   * not configured the button (and the whole API) stays hidden.
   */
  private terminalKb(sessionId: number): InlineKeyboard | undefined {
    const cfg = this.app.config.webapp;
    if (!cfg.enabled || !cfg.url) return undefined;
    const sep = cfg.url.includes("?") ? "&" : "?";
    return new InlineKeyboard().webApp(
      "🖥 Open Session Terminal",
      `${cfg.url}${sep}session=${sessionId}`,
    );
  }

  /** Raw argument string of a `bot.command` update (grammy exposes it as a string). */
  private cmdArg(ctx: Context): string {
    return typeof ctx.match === "string" ? ctx.match.trim() : "";
  }

  /** Whitespace-split arguments of a `bot.command` update. */
  private cmdArgs(ctx: Context): string[] {
    return this.cmdArg(ctx).split(/\s+/).filter(Boolean);
  }

  private projectName(id: number | null): string | undefined {
    return id ? this.app.db.getProject(id)?.name : undefined;
  }

  /** Per-user "active server": own host first, global only for admins/owners. */
  private hostIdForUser(userId: number): number | null {
    return effectiveActiveHostId(this.app, userId);
  }

  /** Canonicalize a directory on the selected host without using a shell string. */
  private async canonicalRemoteDir(hostId: number, candidate: string): Promise<string | null> {
    const r = await this.app.serverMode.execOnHost(hostId, "pwd", [], candidate);
    if (r.code !== 0) return null;
    return r.stdout.trim() || null;
  }

  private isWithin(root: string, candidate: string): boolean {
    return candidate === root || candidate.startsWith(`${root}/`);
  }

  /**
   * A file command is deliberately constrained to projects visible to the
   * caller.  This is a browser, not a general SSH shell: it prevents a bot
   * user from turning /cd or /mkdir into host-wide access.
   */
  private async shellContext(ctx: Context): Promise<{
    hostId: number;
    cwd: string;
    roots: Array<{ root: string; writable: boolean }>;
  } | null> {
    const uid = ctx.from!.id;
    const hostId = this.hostIdForUser(uid);
    if (hostId === null) {
      await ctx.reply("🔌 No server selected. Run /addserver or choose one with /hosts.");
      return null;
    }
    const projects = this.app.db
      .listRemoteProjects(hostId)
      .filter((p) => projectVisibleTo(this.app, uid, p));
    if (!projects.length) {
      await ctx.reply("📁 Register one of your projects first with /addproject <absolute path>.");
      return null;
    }
    const roots = (await Promise.all(projects.map(async (p) => {
      const root = await this.canonicalRemoteDir(hostId, p.root);
      return root ? { root, writable: canManageProject(this.app, uid, p) } : null;
    }))).filter((v): v is { root: string; writable: boolean } => v !== null);
    if (!roots.length) {
      await ctx.reply("❌ Your registered project directory is not available on the selected server.");
      return null;
    }
    const state = this.st(uid);
    const saved = state.shell;
    const cwd = saved && saved.hostId === hostId && roots.some((r) => this.isWithin(r.root, saved.cwd))
      ? saved.cwd
      : roots[0]!.root;
    state.shell = { hostId, cwd };
    return { hostId, cwd, roots };
  }

  private async pwdCommand(ctx: Context): Promise<void> {
    const shell = await this.shellContext(ctx);
    if (shell) await ctx.reply(`📂 ${shell.cwd}`);
  }

  private async cdCommand(ctx: Context): Promise<void> {
    const target = this.cmdArg(ctx);
    if (!target) return void (await this.pwdCommand(ctx));
    const shell = await this.shellContext(ctx);
    if (!shell) return;
    const candidate = target.startsWith("/") ? target : path.posix.join(shell.cwd, target);
    const resolved = await this.canonicalRemoteDir(shell.hostId, candidate);
    if (!resolved || !shell.roots.some((r) => this.isWithin(r.root, resolved))) {
      await ctx.reply("⛔ Directory is unavailable or outside your registered projects.");
      return;
    }
    this.st(ctx.from!.id).shell = { hostId: shell.hostId, cwd: resolved };
    await ctx.reply(`📂 ${resolved}`);
  }

  private async lsCommand(ctx: Context): Promise<void> {
    const target = this.cmdArg(ctx);
    const shell = await this.shellContext(ctx);
    if (!shell) return;
    let cwd = shell.cwd;
    if (target) {
      const candidate = target.startsWith("/") ? target : path.posix.join(shell.cwd, target);
      const resolved = await this.canonicalRemoteDir(shell.hostId, candidate);
      if (!resolved || !shell.roots.some((r) => this.isWithin(r.root, resolved))) {
        await ctx.reply("⛔ Directory is unavailable or outside your registered projects.");
        return;
      }
      cwd = resolved;
    }
    const r = await this.app.serverMode.execOnHost(shell.hostId, "ls", ["-la"], cwd);
    if (r.code !== 0) {
      await ctx.reply(`❌ Cannot list directory: ${this.clip(r.stderr || "command failed")}`);
      return;
    }
    await ctx.reply(`📂 ${cwd}\n\n${this.clip(redactSecrets(r.stdout)) || "(empty)"}`);
  }

  private async mkdirCommand(ctx: Context): Promise<void> {
    const name = this.cmdArg(ctx);
    if (!name || name.includes("/") || name === "." || name === "..") {
      await ctx.reply("Usage: /mkdir <single-directory-name>");
      return;
    }
    const shell = await this.shellContext(ctx);
    if (!shell) return;
    const writable = shell.roots.some((r) => r.writable && this.isWithin(r.root, shell.cwd));
    if (!writable) {
      await ctx.reply("⛔ You can create directories only inside a project you own.");
      return;
    }
    const r = await this.app.serverMode.execOnHost(shell.hostId, "mkdir", ["--", name], shell.cwd);
    if (r.code !== 0) {
      await ctx.reply(`❌ mkdir failed: ${this.clip(r.stderr || "command failed")}`);
      return;
    }
    await ctx.reply(`✅ Created ${shell.cwd}/${name}`);
  }

  private sessionCounts(userId: number): Record<string, number> {
    const sessions = isAdminUser(this.app, userId)
      ? this.app.db.listSessions()
      : this.app.db.listSessionsForOwner(userId);
    const counts: Record<string, number> = {};
    for (const s of sessions) counts[s.status] = (counts[s.status] ?? 0) + 1;
    return counts;
  }

  private clip(s: string): string {
    const trimmed = s.replace(/\s+$/g, "");
    return trimmed.length > 3500 ? trimmed.slice(-3500) : trimmed;
  }

  /**
   * Scrub agent-visible output before it reaches Telegram, history or logs:
   * generic secret patterns first, then every stored Qoder key (defence in
   * depth — an agent that prints its own key still cannot leak it).
   */
  private scrub(text: string): string {
    return this.app.credentials.redactAll(redactSecrets(text));
  }

  private parseLimit(raw: string | undefined, def: number, max: number): number {
    const n = Number((raw ?? "").trim());
    if (!Number.isInteger(n) || n <= 0) return def;
    return Math.min(n, max);
  }

  /** Remote-mode gate for features that only make sense against the user's SSH host. */
  private async requireRemote(ctx: Context): Promise<number | null> {
    const id = this.hostIdForUser(ctx.from!.id);
    if (id === null)
      await ctx.reply("🔌 No server connected. Run /addserver first.");
    return id;
  }

  /** Tail the last `bytes` of a file on the current transport. */
  private async tailRemoteFile(path: string, bytes = 3500): Promise<string> {
    const r = await this.app.runner.execScript(`tail -c ${bytes} ${shq(path)}`);
    if (r.code !== 0)
      return `(cannot read log: ${(r.stderr || `exit ${r.code}`).slice(0, 200)})`;
    return this.clip(this.scrub(r.stdout));
  }

  private cancelWizards(uid: number): void {
    const s = this.st(uid);
    s.serverWizard = undefined;
    s.projectWizard = undefined;
    s.wizard = undefined;
    s.pendingKeyEntry = undefined;
  }

  private healthText(): string {
    const app = this.app;
    const conn = app.serverMode.connection;
    const lines: Array<string | null> = [
      "🩺 HEALTH",
      "",
      `Mode: ${app.sessions.remoteMode ? "remote (SSH)" : "local (no host)"}`,
      conn
        ? `SSH: ${conn.state}${conn.lastErrorMessage ? ` — ${conn.lastErrorMessage.slice(0, 120)}` : ""}`
        : null,
      "",
      ...app.tracker.modules().map((m) => {
        const st = app.tracker.state(m);
        const last = app.tracker.recent(m, 1)[0];
        return `${st === "error" ? "🔴" : "🟢"} ${m.padEnd(9)} ${app.tracker.count24h(m)} err/24h` +
          (last ? `  · last: ${ago(last.at)} ${last.message.slice(0, 80)}` : "");
      }),
    ];
    return lines.filter((l): l is string => l !== null).join("\n");
  }

  private mainMenu(admin: boolean): InlineKeyboard {
    const kb = new InlineKeyboard()
      .text("🧠 Sessions", "nav:sessions").row()
      .text("➕ New Session", "nav:new").row()
      .text("📁 Projects", "nav:projects").text("🌿 Git", "nav:git").row()
      .text("🖥 My Servers", "nav:hosts").text("📜 Logs", "nav:logs").row()
      .text("🔑 Qoder Key", "nav:qoderkey").row()
      .text("➕ Add Server", "nav:addserver").text("📁 Add Project", "nav:addproject").row();
    if (admin)
      kb
        .text("🖥 Server Status", "nav:server").text("📟 Processes", "nav:processes").row()
        .text("⚠️ Alerts", "nav:alerts").text("🩺 Health", "nav:health").row()
        .text("⚙️ Settings", "nav:settings");
    return kb;
  }

  private async sessionsOverview(ctx: Context): Promise<void> {
    const uid = ctx.from!.id;
    const admin = isAdminUser(this.app, uid);
    const sessions = admin
      ? this.app.db.listSessions()
      : this.app.db.listSessionsForOwner(uid);
    const text = sessionsList(
      sessions,
      (id) => this.projectName(id),
      admin ? (s) => (s.owner_telegram_user_id == null ? "legacy · unowned" : `owner ${s.owner_telegram_user_id}`) : undefined,
    );
    const kb = new InlineKeyboard();
    for (const s of sessions) kb.text(`${s.id}. ${s.name}`, `sess:${s.id}`).row();
    kb.text("⬅ Back", "menu:main");
    await ctx.reply(text.length > 4000 ? text.slice(0, 4000) : text, {
      reply_markup: kb,
    });
  }

  private async enterChat(ctx: Context, sessionId: number): Promise<void> {
    const s = this.ownedSession(ctx, sessionId);
    if (!s) {
      // unknown id and someone else's id produce the SAME generic refusal
      await this.deny(ctx);
      return;
    }
    this.st(ctx.from!.id).activeSession = sessionId;
    const out = await this.app.sessions.capture(sessionId, 40);
    await ctx.reply(
      `💬 Chatting with ${s.agent_type} #${s.id} (${s.status})\n` +
        `Send any message to forward it to the agent.\n\n` +
        `Recent output:\n${this.clip(this.scrub(out)) || "(no output yet)"}`,
      { reply_markup: this.terminalKb(sessionId) },
    );
  }

  private summaryText(id: number): string {
    const s = this.app.db.getSession(id);
    if (!s) return `Session #${id} not found.`;
    const sum = this.app.sessions.summary(id);
    if (!sum) return `No summary available for #${id}.`;
    return [
      "🧠 SESSION SUMMARY",
      "",
      `Agent: ${sum.agent}  ·  Project: ${this.projectName(s.project_id) ?? "—"}`,
      `Duration: ${sum.duration}`,
      sum.completed.length
        ? "\nCompleted:\n" + sum.completed.map((c) => "  " + c).join("\n")
        : "",
      sum.failed.length
        ? "\nFailed:\n" + sum.failed.map((c) => "  " + c).join("\n")
        : "",
      `\nCurrent: ${sum.current}`,
      sum.lastQuestion ? `Last question:\n${sum.lastQuestion}` : "",
      sum.changedFiles != null ? `\nChanged files: ${sum.changedFiles}` : "",
      sum.lastCommit ? `Last commit: ${sum.lastCommit}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * A credential refusal must read EXACTLY as specified (no ❌ decoration);
   * everything else keeps the error prefix.
   */
  private async fail(ctx: Context, e: unknown): Promise<void> {
    const msg = String((e as Error).message);
    await ctx.reply(e instanceof CredentialRequiredError ? msg : `❌ ${msg}`);
  }

  private async safe(fn: () => Promise<unknown>, ctx: Context, ok: string): Promise<void> {
    try {
      await fn();
      await ctx.reply(ok);
    } catch (e) {
      await this.fail(ctx, e);
    }
  }

  /** /send <sessionId> <prompt> — direct input to the user's own session. */
  async sendCommand(ctx: Context): Promise<void> {
    const arg = this.cmdArg(ctx);
    const m = arg.match(/^(\d+)\s+([\s\S]+)$/);
    if (!m) {
      await ctx.reply("Usage: /send <session id> <message>");
      return;
    }
    const id = Number(m[1]);
    const s = this.ownedSession(ctx, id);
    if (!s) return this.deny(ctx);
    try {
      // input goes through the SessionManager security path, never a raw shell
      await this.app.sessions.sendInput(id, m[2]!);
      const out = await this.app.sessions.capture(id, 15);
      await ctx.reply(
        `✅ Sent to session #${id} (${s.status}).\n\nLatest output:\n${this.clip(this.scrub(out)) || "(no output yet)"}`,
      );
    } catch (e) {
      await this.fail(ctx, e);
    }
  }

  /**
   * /qoder <sessionId> <input> — pass raw Qoder TUI input through Telegram.
   * Telegram consumes leading slash commands itself, so chat mode cannot carry
   * Qoder commands such as `/help`, `/status`, or `/login` unchanged.
   */
  async qoderCommand(ctx: Context): Promise<void> {
    const arg = this.cmdArg(ctx);
    const m = arg.match(/^(\d+)\s+([\s\S]+)$/);
    if (!m) {
      await ctx.reply("Usage: /qoder <session id> <Qoder input>\nExample: /qoder 12 /help");
      return;
    }
    const id = Number(m[1]);
    const s = this.ownedSession(ctx, id);
    if (!s) return this.deny(ctx);
    if (s.agent_type !== "qoder") {
      await ctx.reply(`Session #${id} is ${s.agent_type}, not Qoder.`);
      return;
    }
    try {
      // Deliberately forward byte-for-byte after the session id: this is TUI
      // input, never a shell command, and still goes through secret checks.
      await this.app.sessions.sendInput(id, m[2]!);
      const out = await this.app.sessions.capture(id, 15);
      await ctx.reply(
        `✅ Sent to Qoder session #${id}.\n\nLatest output:\n${this.clip(this.scrub(out)) || "(no output yet)"}`,
      );
    } catch (e) {
      await this.fail(ctx, e);
    }
  }

  /** /history <sessionId> [limit] — full executive history of the user's session. */
  async historyCommand(ctx: Context): Promise<void> {
    const args = this.cmdArgs(ctx);
    const id = Number(args[0]);
    if (!id) {
      await ctx.reply("Usage: /history <session id> [limit]");
      return;
    }
    const s = this.ownedSession(ctx, id);
    if (!s) return this.deny(ctx);
    const limit = this.parseLimit(args[1], HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);
    await ctx.reply(await this.historyText(s, limit));
  }

  async stopCommand(ctx: Context): Promise<void> {
    const id = Number(this.cmdArg(ctx));
    if (!id) {
      await ctx.reply("Usage: /stop <id>");
      return;
    }
    if (!this.ownedSession(ctx, id)) return this.deny(ctx);
    await this.safe(() => this.app.sessions.stop(id), ctx, `⏹ Session #${id} stopped.`);
  }

  async killCommand(ctx: Context): Promise<void> {
    const id = Number(this.cmdArg(ctx));
    if (!id) {
      await ctx.reply("Usage: /kill <id>");
      return;
    }
    if (!this.ownedSession(ctx, id)) return this.deny(ctx);
    await this.safe(() => this.app.sessions.stop(id), ctx, `🛑 Session #${id} killed.`);
  }

  async removeProjectCommand(ctx: Context): Promise<void> {
    const app = this.app;
    const id = Number(this.cmdArg(ctx));
    if (!id) {
      await ctx.reply("Usage: /removeproject <id>");
      return;
    }
    const p = resolveProject(app, ctx.from!.id, id);
    if (!p) return this.deny(ctx);
    if (!canManageProject(app, ctx.from!.id, p)) return this.deny(ctx);
    const sessions = app.db.listSessions().filter((s) => s.project_id === id);
    if (sessions.some((s) => ["STARTING", "WORKING", "WAITING_INPUT", "WAITING_APPROVAL"].includes(s.status))) {
      await ctx.reply(`❌ Project #${id} has active sessions — stop them first.`);
      return;
    }
    app.db.deleteProject(id);
    await ctx.reply(`🗑 Project "${p.name}" removed from TeleOps (files on the server are untouched).`);
  }

  async textMessage(ctx: Context): Promise<void> {
    const app = this.app;
    const text = ctx.message?.text;
    if (!text) return;
    const state = this.st(ctx.from!.id);

    if (state.pendingKeyEntry) {
      if (text.startsWith("/")) return;
      await this.handleKeyEntry(ctx, text);
      return;
    }
    if (state.serverWizard) {
      if (text.startsWith("/")) return;
      await this.handleServerWizard(ctx, text);
      return;
    }
    if (state.projectWizard) {
      // Project paths are absolute and therefore begin with '/'.  The old
      // generic "ignore commands" guard discarded every valid Linux path
      // before it reached registerProject.
      if (text === "/cancel") return;
      if (text.startsWith("/") && !text.slice(1).includes("/")) {
        await ctx.reply("📁 I am waiting for an absolute project path. Send e.g. /srv/app, or /cancel first.");
        return;
      }
      const hostId = this.hostIdForUser(ctx.from!.id);
      if (hostId === null) {
        await ctx.reply("🔌 No server connected. Run /addserver first.");
        return;
      }
      const registered = await this.registerProject(ctx, hostId, text.trim());
      if (registered) state.projectWizard = undefined;
      return;
    }
    if (text.startsWith("/")) return;
    if (state.wizard?.step === "task") {
      await this.finishWizard(ctx, text);
      return;
    }
    if (state.activeSession) {
      // ownership is RE-CHECKED on every message — callback data and stale
      // state are never trusted
      const s = resolveSession(app, ctx.from!.id, state.activeSession);
      if (!s) {
        state.activeSession = undefined;
        return this.deny(ctx);
      }
      try {
        await app.sessions.sendInput(state.activeSession, text);
        const out = await app.sessions.capture(state.activeSession, 30);
        await ctx.reply(`⏳ ${this.clip(this.scrub(out)) || "sent"}`);
      } catch (e) {
        await this.fail(ctx, e);
      }
      return;
    }
    await ctx.reply("Open a session with /sessions or /session <id>, then chat here.");
  }

  // ---------- registration ----------
  private register(): void {
    const app = this.app;

    this.bot.use(async (ctx, next) => {
      if (!this.allowed(ctx)) {
        if (ctx.from) {
          app.logs.system.warn("unauthorized telegram user", { id: ctx.from.id });
          await ctx
            .reply("⛔ Not authorized. Ask the operator to add your Telegram user id to the allowlist.")
            .catch(() => {});
        }
        return;
      }
      // Record where this user's notifications must go (per-user, not global).
      if (ctx.from?.id != null && ctx.chat?.id != null)
        app.db.upsertUserChat(ctx.from.id, ctx.chat.id);
      await next();
    });

    this.bot.command("start", (ctx) =>
      ctx.reply("🤖 AI COMMAND CENTER\nChoose an option:", { reply_markup: this.mainMenu(this.isAdmin(ctx)) }),
    );

    this.bot.command("help", (ctx) =>
      ctx.reply(
        [
          "Commands:",
          "/addserver       connect a remote server (SSH) — becomes YOUR private server",
          "/hosts           list your servers, pick your active one",
          "/addproject      register a project path on the server",
          "/removeproject <id>",
          "/projects        list projects you can access",
          "/pwd /ls [dir] /cd <dir> /mkdir <name>  browse your registered projects",
          "/sessions        list YOUR sessions (admins see all)",
          "/new             create a session (remote projects only)",
          "/session <id>    chat with one of your sessions",
          "/send <id> <msg> send a message straight to your session without chat mode",
          "/qoder <id> <input> send raw Qoder TUI input (e.g. /qoder 12 /help)",
          "/history <id> [limit]  input/output + event history of your session",
          "/stop <id> /resume <id> /kill <id>",
          "/summary <id>    rule-based summary",
          "/git <id>        git status for a session",
          "/logs [id] [limit]  task logs of your sessions",
          "/qoderkey      status of YOUR Qoder credential + set/replace/delete token",
          "                 (the token message is deleted right after saving)",
          "/memory [project id] recent tasks memory",
          "/cancel          abort the current wizard",
          "",
          "Admin only: /server /processes /health /alerts /settings /claim /credentials",
          "",
          "Core ≠ Telegram: all actions go through the control-plane layers.",
        ].join("\n"),
      ),
    );

    const serverReply = async (ctx: Context) => {
      if (!(await this.requireAdmin(ctx))) return;
      const counts = this.sessionCounts(ctx.from!.id);
      const full = app.monitor.fullReport
        ? await app.monitor.fullReport().catch((e) => {
            app.tracker.report("monitor", e, { step: "full_report" });
            return null;
          })
        : null;
      if (full) await ctx.reply(serverStatusExtended(full, counts));
      else await ctx.reply(serverStatus(await app.monitor.metrics(), counts));
    };
    this.bot.command("status", serverReply);
    this.bot.command("server", serverReply);

    this.bot.command("sessions", (ctx) => this.sessionsOverview(ctx));

    this.bot.command("addserver", (ctx) => {
      this.st(ctx.from!.id).serverWizard = { step: "host", draft: {} };
      return ctx.reply(
        "🖥 Add server (1/4)\n\nSend the server address (IP or hostname).\nType /cancel to abort.",
      );
    });

    this.bot.command("hosts", (ctx) => this.hostsOverview(ctx));

    this.bot.command("cancel", (ctx) => {
      this.cancelWizards(ctx.from!.id);
      return ctx.reply("Cancelled.");
    });

    this.bot.command("addproject", async (ctx) => {
      const hostId = await this.requireRemote(ctx);
      if (hostId === null) return;
      const arg = this.cmdArg(ctx);
      if (arg) {
        await this.registerProject(ctx, hostId, arg);
        return;
      }
      this.st(ctx.from!.id).projectWizard = true;
      await ctx.reply(
        "📁 Send the absolute project path on the server (e.g. /srv/app).\nType /cancel to abort.",
      );
    });

    this.bot.command("removeproject", (ctx) => this.removeProjectCommand(ctx));

    // Deliberately small, project-confined file browser. These are not a raw
    // shell and accept no arbitrary Linux commands or flags.
    this.bot.command("pwd", (ctx) => this.pwdCommand(ctx));
    this.bot.command("ls", (ctx) => this.lsCommand(ctx));
    this.bot.command("cd", (ctx) => this.cdCommand(ctx));
    this.bot.command("mkdir", (ctx) => this.mkdirCommand(ctx));

    this.bot.command("projects", (ctx) => {
      const uid = ctx.from!.id;
      const ps = isAdminUser(app, uid)
        ? app.db.listProjects()
        : app.db.listProjectsForOwner(uid);
      if (!ps.length)
        return ctx.reply(
          app.sessions.remoteMode
            ? "No projects yet. Register one with /addproject."
            : "No projects yet. Connect a server with /addserver, then /addproject.",
        );
      const lines = ps.map((p, i) => {
        const host = p.host_id ? app.hosts.getHost(p.host_id) : undefined;
        const tag = host ? `remote @ ${host.host}` : "local";
        const shared = p.visibility === "shared" ? "  [shared]" : "";
        return `${i + 1}. ${p.name}  [${tag}]${shared}\n   ${p.root}`;
      });
      return ctx.reply("📁 PROJECTS\n\n" + lines.join("\n\n"));
    });

    this.bot.command("session", async (ctx) => {
      const id = Number(this.cmdArg(ctx));
      if (!id) return ctx.reply("Usage: /session <id>");
      await this.enterChat(ctx, id);
    });

    this.bot.command("send", (ctx) => this.sendCommand(ctx));
    this.bot.command("qoder", (ctx) => this.qoderCommand(ctx));

    // /qoderkey — status + token entry: the bot takes the token as a chat
    // reply ONLY inside that flow and deletes both messages right after saving.
    this.bot.command("qoderkey", (ctx) => this.qoderKeyCommand(ctx));
    this.bot.command("qoder-key", (ctx) => this.qoderKeyCommand(ctx));

    this.bot.command("credentials", async (ctx) => {
      if (!(await this.requireAdmin(ctx))) return;
      ctx.reply(this.credentialsStatusText());
    });

    this.bot.command("history", (ctx) => this.historyCommand(ctx));

    this.bot.command("processes", async (ctx) => {
      if (!(await this.requireAdmin(ctx))) return;
      ctx.reply(processesList(await app.monitor.topProcesses()));
    });

    this.bot.command("alerts", async (ctx) => {
      if (!(await this.requireAdmin(ctx))) return;
      const pending = app.approvals.pending();
      const bad = app.db
        .listSessions()
        .filter((s) => s.status === "ERROR" || s.status === "CRASHED");
      const failing = app.tracker
        .modules()
        .filter((m) => app.tracker.state(m) === "error");
      const recent = app.tracker.recent(undefined, 3);
      return ctx.reply(
        [
          "⚠️ ALERTS",
          "",
          `Pending approvals: ${pending.length}`,
          `Sessions in error/crashed: ${bad.length}`,
          ...bad.map((s) => `  #${s.id} ${s.name} [${s.status}]`),
          failing.length ? `\nModules with recent errors: ${failing.join(", ")}` : "",
          ...recent.map(
            (e) => `  [${e.module}] ${ago(e.at)}: ${e.message.slice(0, 120)}`,
          ),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    });

    this.bot.command("health", async (ctx) => {
      if (!(await this.requireAdmin(ctx))) return;
      ctx.reply(this.healthText());
    });

    this.bot.command("memory", async (ctx) => {
      const hostId = await this.requireRemote(ctx);
      if (hostId === null) return;
      const uid = ctx.from!.id;
      const id = Number(this.cmdArg(ctx));
      const projects = app.db
        .listRemoteProjects(hostId)
        .filter((p) => projectVisibleTo(app, uid, p));
      const project = id ? projects.find((p) => p.id === id) : projects[0];
      if (!project) return ctx.reply("No project found — register one with /addproject.");
      if (!app.projectFiles) return;
      const entries = await app.projectFiles.readMemory(project.root);
      if (!entries.length) return ctx.reply(`🧠 ${project.name}: memory is empty.`);
      await ctx.reply(
        `🧠 MEMORY — ${project.name} (${entries.length} entries)\n\n` +
          entries
            .slice(0, 10)
            .map(
              (e) =>
                `${ago(e.ts)} · #${e.session_id} ${e.agent} · ${e.status}\n  ${e.task.slice(0, 100)}` +
                (e.summary ? `\n  ↳ ${e.summary.slice(0, 140)}` : ""),
            )
            .join("\n\n"),
      );
    });

    this.bot.command("settings", async (ctx) => {
      if (!(await this.requireAdmin(ctx))) return;
      ctx.reply(
        `⚙️ SETTINGS\nmax_concurrent: ${app.config.sessions.max_concurrent}\n` +
          `heartbeat: ${app.config.sessions.heartbeat_interval_seconds}s\n` +
          `agents: ${app.adapters.ids().join(", ")}\n` +
          `allowed_users: ${app.config.security.allowed_users.length}\n` +
          `admin_users: ${app.config.security.admin_users?.length ?? "not set (legacy: every allowed user is admin)"}`,
      );
    });

    this.bot.command("logs", (ctx) => {
      const args = this.cmdArgs(ctx);
      const sessionId = Number(args[0]) || undefined;
      const limit = this.parseLimit(args[1], LOGS_DEFAULT_LIMIT, LOGS_MAX_LIMIT);
      return this.showLogs(ctx, sessionId, limit);
    });

    this.bot.command("summary", async (ctx) => {
      const id = Number(this.cmdArg(ctx));
      if (!id) return ctx.reply("Usage: /summary <session id>");
      const s = this.ownedSession(ctx, id);
      if (!s) return this.deny(ctx);
      await ctx.reply(this.summaryText(id));
    });

    this.bot.command("stop", (ctx) => this.stopCommand(ctx));

    this.bot.command("resume", async (ctx) => {
      const id = Number(this.cmdArg(ctx));
      if (!id) return ctx.reply("Usage: /resume <id>");
      if (!this.ownedSession(ctx, id)) return this.deny(ctx);
      await this.safe(() => app.sessions.resume(id), ctx, `▶ Session #${id} resumed.`);
    });

    this.bot.command("kill", (ctx) => this.killCommand(ctx));

    this.bot.command("new", (ctx) => this.startWizard(ctx));

    this.bot.command("git", async (ctx) => {
      const id = Number(this.cmdArg(ctx));
      if (!id) return ctx.reply("Usage: /git <session id>");
      await this.gitView(ctx, id);
    });

    // Admin-only ownership takeover for legacy (unowned) resources.
    this.bot.command("claim", async (ctx) => {
      if (!(await this.requireAdmin(ctx))) return;
      const [kind, idStr, userStr] = this.cmdArg(ctx).split(/\s+/);
      const id = Number(idStr);
      const target = userStr ? Number(userStr) : ctx.from!.id;
      if (!kind || !["session", "project", "host"].includes(kind) || !id || !target)
        return ctx.reply("Usage: /claim <session|project|host> <id> [telegram_user_id]");
      if (!isAllowedUser(app, target)) return ctx.reply(`User ${target} is not in allowed_users.`);
      if (kind === "session" && app.db.getSession(id)) app.db.setSessionOwner(id, target);
      else if (kind === "project" && app.db.getProject(id)) app.db.setProjectOwner(id, target);
      else if (kind === "host") {
        const h = app.db.getHost(id);
        if (h) app.db.raw().prepare("UPDATE ssh_hosts SET owner_telegram_user_id = ? WHERE id = ?").run(target, id);
      } else return ctx.reply(`No ${kind} #${id} found.`);
      await ctx.reply(`🔑 ${kind} #${id} is now owned by ${target}.`);
    });

    // Plain text → wizard steps, else forward to the active session (docs §7).
    this.bot.on("message:text", (ctx) => this.textMessage(ctx));

    this.bot.on("callback_query:data", (ctx) => this.handleCallback(ctx));
  }

  // ---------- per-user servers ----------
  private async hostsOverview(ctx: Context): Promise<void> {
    const uid = ctx.from!.id;
    const hosts = isAdminUser(this.app, uid)
      ? this.app.db.listHosts()
      : this.app.db.listHostsForOwner(uid);
    if (!hosts.length) {
      await ctx.reply("🖥 No servers registered for you yet. Use /addserver.");
      return;
    }
    const active = this.hostIdForUser(uid);
    const kb = new InlineKeyboard();
    const lines = hosts.map((h) => {
      const mine = h.owner_telegram_user_id === uid ? "you" : h.owner_telegram_user_id == null ? "legacy" : `owner ${h.owner_telegram_user_id}`;
      kb.text(`${h.id}. ${h.name}`, `hostuse:${h.id}`).text("🗑", `hostdel:${h.id}`).row();
      return `${h.id === active ? "⭐" : "  "} ${h.id}. ${h.name} — ${h.username}@${h.host}:${h.port}  (${h.visibility === "shared" ? "shared" : `private · ${mine}`})`;
    });
    await ctx.reply("🖥 MY SERVERS\n\n" + lines.join("\n") + "\n\n⭐ = your active server", {
      reply_markup: kb,
    });
  }

  private async handleHostUse(ctx: Context, hostId: number): Promise<void> {
    const uid = ctx.from!.id;
    const host = resolveHost(this.app, uid, hostId);
    if (!host) return this.deny(ctx);
    this.app.hosts.activateHostForUser(uid, hostId);
    let note = `🖥 Active server set to "${host.name}".`;
    const globalActive = this.app.db.getActiveHost();
    if (globalActive?.id === hostId) {
      try {
        await this.app.serverMode.switchActiveHost(hostId);
        note += "\nTransport switched to this server.";
      } catch (e) {
        this.app.tracker.report("ssh", e, { step: "switch_host", host: host.name });
        note += `\n⚠️ Live switch failed: ${(e as Error).message}`;
      }
    } else {
      note += "\n⚠️ Another server is currently connected globally; ask an admin to switch the transport.";
    }
    await ctx.reply(note);
  }

  private async handleHostDelete(ctx: Context, hostId: number): Promise<void> {
    const uid = ctx.from!.id;
    const host = resolveHost(this.app, uid, hostId);
    if (!host) return this.deny(ctx);
    // normal users may only delete hosts they own (not shared ones)
    if (!isAdminUser(this.app, uid) && (host.owner_telegram_user_id !== uid || host.visibility === "shared"))
      return this.deny(ctx);
    const projects = this.app.db.listRemoteProjects(hostId);
    if (projects.some((p) => this.app.db.listSessionsForOwner(uid).some((s) => s.project_id === p.id))) {
      await ctx.reply("❌ This server still has your active projects/sessions — remove them first.");
      return;
    }
    this.app.db.deleteHost(hostId);
    this.app.db.raw().prepare("DELETE FROM user_active_hosts WHERE telegram_user_id = ? AND host_id = ?").run(uid, hostId);
    let note = `🗑 Server "${host.name}" removed.`;
    if (isAdminUser(this.app, uid) && !this.app.db.getActiveHost()) {
      try {
        await this.app.serverMode.switchActiveHost(null);
        note += "\nTransport returned to local.";
      } catch {
        /* noop */
      }
    }
    await ctx.reply(note);
  }

  // ---------- history ----------
  private async historyText(s: SessionRecord, limit: number): Promise<string> {
    const messages = this.app.db.listMessages(s.id, limit);
    const events = this.app.db.listEvents(s.id, limit);
    const rows: Array<{ at: string; line: string }> = [
      ...messages.map((m) => ({
        at: m.created_at,
        line:
          m.direction === "USER_TO_AGENT"
            ? `⬆ [you] ${m.content.slice(0, 200)}`
            : m.direction === "AGENT_TO_USER"
              ? `⬇ [agent] ${m.content.slice(0, 200)}`
              : `· [system] ${m.content.slice(0, 200)}`,
      })),
      ...events.map((e) => ({
        at: e.created_at,
        line: `• ${e.type}${e.severity ? ` (${e.severity})` : ""} ${JSON.stringify(e.payload ?? {}).slice(0, 120)}`,
      })),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const head =
      `🗂 HISTORY — session #${s.id} "${s.name}"\n` +
      `Status: ${s.status}  ·  Agent: ${s.agent_type}  ·  Created: ${s.created_at}\n` +
      `Last activity: ${ago(s.updated_at)}\n\n`;
    const body = rows.slice(-limit).map((r) => `${r.at.slice(11)} ${r.line}`).join("\n");
    return this.clip(head + this.scrub(body || "(no history recorded yet)"));
  }

  // ---------- server wizard ----------
  private async handleServerWizard(ctx: Context, text: string): Promise<void> {
    const app = this.app;
    const uid = ctx.from!.id;
    const state = this.st(uid);
    const w = state.serverWizard;
    if (!w) return;
    const value = text.trim();

    if (w.step === "host") {
      if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
        await ctx.reply("❌ That doesn't look like a valid hostname or IP. Try again or /cancel.");
        return;
      }
      w.draft.host = value;
      w.step = "port";
      await ctx.reply(`🖥 Add server (2/4)\n\nSSH port for ${value}? (send a number, or "default" for 22)`);
      return;
    }
    if (w.step === "port") {
      const port = value === "default" || value === "22" ? 22 : Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        await ctx.reply('❌ Port must be a number 1–65535 (or "default"). Try again.');
        return;
      }
      w.draft.port = port;
      w.step = "user";
      await ctx.reply("🖥 Add server (3/4)\n\nSSH username?");
      return;
    }
    if (w.step === "user") {
      if (!/^[A-Za-z0-9._-]+$/.test(value)) {
        await ctx.reply("❌ Invalid username. Try again or /cancel.");
        return;
      }
      w.draft.username = value;
      w.step = "pass";
      await ctx.reply(
        "🖥 Add server (4/4)\n\nSend the SSH password. It is stored encrypted (AES-256-GCM) " +
          "and I will try to delete this message after saving.",
      );
      return;
    }

    // step "pass" — test, then persist (owned by this user) + activate
    if (!value) {
      await ctx.reply("❌ Empty password. Try again or /cancel.");
      return;
    }
    const { host, port, username } = w.draft;
    const chatId = ctx.chat?.id;
    const testing = await ctx.reply(`⏳ Testing connection to ${username}@${host}:${port}…`);
    const result = await app.hosts.testConnection({ host: host!, port: port!, username: username!, password: value });
    try {
      if (chatId) await this.bot.api.deleteMessage(chatId, testing.message_id);
    } catch {
      /* noop */
    }
    if (!result.ok) {
      await ctx.reply(
        `❌ Connection failed: ${result.error ?? "unknown error"}\n\n` +
          "Send the correct password to retry, or /cancel.",
      );
      return;
    }
    let saved;
    try {
      saved = app.hosts.addHost({
        host: host!,
        port: port!,
        username: username!,
        password: value,
        activate: true,
        owner: uid,
      });
    } catch (e) {
      app.tracker.report("config", e, { step: "save_host" });
      await ctx.reply(`❌ Connected, but saving failed: ${(e as Error).message}`);
      return;
    }
    state.serverWizard = undefined;
    try {
      if (chatId && ctx.msg) await this.bot.api.deleteMessage(chatId, ctx.msg.message_id);
    } catch {
      app.logs.system.warn("could not delete password message — remove it manually");
    }
    // The global SSH transport follows the GLOBAL active host, which addHost
    // only flips for admins (or when nothing was active yet). Normal users
    // never steal the transport from another user's server.
    const globalActive = app.db.getActiveHost();
    if (globalActive?.id === saved.id) {
      try {
        await app.serverMode.switchActiveHost(saved.id);
      } catch (e) {
        app.tracker.report("ssh", e, { step: "switch_host", host: saved.name });
        await ctx.reply(
          `⚠️ Host "${saved.name}" saved and tested OK, but the live switch failed: ${(e as Error).message}\n` +
            "Re-run /addserver with the same address to retry.",
        );
        return;
      }
      await ctx.reply(
        `✅ Server connected: ${result.hostname ?? host} (user ${result.user ?? username})\n` +
          `Transport switched to SSH — no restart needed.\n` +
          (result.tmux ? `tmux: ${result.tmux}\n` : `⚠️ tmux NOT found on the server — install it before creating sessions.\n`) +
          `\nNext: /addproject <path> to register a project on this server.`,
      );
      return;
    }
    await ctx.reply(
      `✅ Server "${saved.name}" saved as your private server (#${saved.id}) and set as YOUR active one.\n` +
        `⚠️ Another server is currently connected globally, so remote execution still uses that host. ` +
        `Ask an admin to switch (or /hosts → select) when yours should go live.`,
    );
  }

  // ---------- project registration ----------
  /** Returns true when registration has completed (including an existing row). */
  private async registerProject(ctx: Context, hostId: number, rawPath: string): Promise<boolean> {
    const app = this.app;
    const uid = ctx.from!.id;
    const host = resolveHost(app, uid, hostId);
    if (!host) {
      await this.deny(ctx);
      return false;
    }
    const path = rawPath.replace(/\/+$/, "");
    if (!path.startsWith("/") || path.length < 2) {
      await ctx.reply("❌ Path must be absolute on the server (e.g. /srv/app).");
      return false;
    }
    if (/[\x00-\x1f]/.test(path)) {
      await ctx.reply("❌ Invalid characters in path.");
      return false;
    }

    // Do not use app.runner here: it is the long-lived transport used by
    // tmux/monitoring and can belong to another user's selected host. Project
    // registration must validate against the host selected by THIS caller.
    const exists = await app.serverMode.execOnHost(hostId, "test", ["-d", path]);
    if (exists.code !== 0) {
      await ctx.reply(`❌ Directory not found on the server: ${path}\n(${exists.stderr.slice(0, 200)})`);
      return false;
    }

    const dup = app.db
      .listRemoteProjects(hostId)
      .filter((p) => projectVisibleTo(app, uid, p))
      .find((p) => p.root.replace(/\/+$/, "") === path);
    if (dup) {
      await ctx.reply(`ℹ️ Already registered as project #${dup.id} "${dup.name}".`);
      return true;
    }

    const repoCheck = await app.serverMode.execOnHost(
      hostId,
      "git",
      ["-C", path, "rev-parse", "--is-inside-work-tree"],
    );
    const isRepo = repoCheck.code === 0 && repoCheck.stdout.trim() === "true";
    const project = app.db.createProject(basename(path), path, hostId, uid, "private");
    await ctx.reply(
      `📁 Project #${project.id} "${project.name}" registered → ${path}\n` +
        (isRepo ? "Git repository: ✅ yes" : "⚠️ Not a git repository — /git will not work for sessions here."),
    );
    return true;
  }

  // ---------- task logs ----------
  private async taskLogText(t: { id: number; session_id: number; status: string; remote_path: string; task: string | null; started_at: string; ended_at: string | null; size_bytes: number | null }): Promise<string> {
    const size = t.size_bytes != null ? `${t.size_bytes} B` : "—";
    const head =
      `📜 Task log #${t.id} · session #${t.session_id} · ${t.status}\n` +
      `File: ${t.remote_path} (${size})\n` +
      `Started: ${t.started_at}  ·  Ended: ${t.ended_at ?? "—"}\n` +
      `Task: ${(t.task ?? "—").slice(0, 150)}`;
    const body = await this.tailRemoteFile(t.remote_path);
    return `${head}\n\n${body || "(empty log)"}`;
  }

  private logButtons(t: { id: number; session_id: number }): InlineKeyboard {
    return new InlineKeyboard()
      .text("↻ Refresh", `logtail:${t.id}`)
      .text("📋 All logs", `loglist:${t.session_id}`)
      .row()
      .text("📟 Live screen", `act:logs:${t.session_id}`);
  }

  private async showLogs(ctx: Context, sessionId?: number, limit = LOGS_DEFAULT_LIMIT): Promise<void> {
    const app = this.app;
    const uid = ctx.from!.id;
    if (sessionId === undefined) {
      const latest = isAdminUser(app, uid)
        ? app.db.listTaskLogs({}, 1)[0]
        : app.db.listTaskLogsForOwner(uid, 1)[0];
      if (!latest) {
        await ctx.reply("📜 No task logs yet. Logs are recorded when a session starts in a registered project.");
        return;
      }
      await ctx.reply(await this.taskLogText(latest), { reply_markup: this.logButtons(latest) });
      return;
    }
    const session = this.ownedSession(ctx, sessionId);
    if (!session) {
      await this.deny(ctx);
      return;
    }
    const logs = app.db.listTaskLogs({ session_id: sessionId }, limit);
    if (!logs.length) {
      await ctx.reply(
        `No recorded logs for session #${sessionId} yet (this session has no .teleops/logs file).\n` +
          "Use 📟 Live screen or /capture-style output via /session.",
      );
      return;
    }
    const kb = new InlineKeyboard();
    for (const t of logs)
      kb
        .text(
          `#${t.id} ${t.status} · ${ago(t.started_at)} · ${(t.task ?? "").slice(0, 24) || "no task"}`,
          `logview:${t.id}`,
        )
        .row();
    kb.text("📟 Live screen", `act:logs:${sessionId}`);
    const current = logs[0]!;
    await ctx.reply(
      `📜 LOGS — session #${sessionId} (${logs.length} files)\n\nShowing the newest:\n\n` +
        (await this.taskLogText(current)),
      { reply_markup: kb },
    );
  }

  // ---------- wizard ----------
  private async startWizard(ctx: Context): Promise<void> {
    const uid = ctx.from!.id;
    const hostId = this.hostIdForUser(uid);
    if (hostId === null) {
      await ctx.reply("🔌 Sessions run on a registered server project. Connect one with /addserver, then /addproject.");
      return;
    }
    const kb = new InlineKeyboard();
    const projects = this.app.db
      .listRemoteProjects(hostId)
      .filter((p) => projectVisibleTo(this.app, uid, p));
    if (!projects.length) {
      await ctx.reply("📁 No projects on this server yet. Register one with /addproject <path>.");
      return;
    }
    for (const p of projects) kb.text(p.name, `proj:${p.id}`).row();
    this.st(uid).wizard = { step: "agent" };
    await ctx.reply("New session — 1/3 select project:", { reply_markup: kb });
  }

  private async finishWizard(ctx: Context, task: string): Promise<void> {
    const uid = ctx.from!.id;
    const w = this.st(uid).wizard;
    if (!w?.agent) return;
    // the wizard's stored project id is re-authorized here, not trusted blindly
    const project =
      w.project_id != null ? resolveProject(this.app, uid, w.project_id) : undefined;
    if (w.project_id != null && !project) {
      this.st(uid).wizard = undefined;
      return this.deny(ctx);
    }
    if (!project && !isAdminUser(this.app, uid)) {
      // ad-hoc local sessions touch the TeleOps host itself → admin only
      this.st(uid).wizard = undefined;
      await ctx.reply("⛔ Pick one of your projects with /new — free-form sessions are admin-only.");
      return;
    }
    // An agent that declares a credential runs ONLY with this user's own key.
    // Checked here so nothing is created/started and the wording is exact;
    // SessionManager enforces the same gate independently (fail-closed).
    if (
      this.app.adapters.get(w.agent)?.credentialEnvVar &&
      !this.app.credentials.hasCredential(uid)
    ) {
      await ctx.reply(
        CREDENTIAL_REQUIRED_MESSAGE +
          "\n\nRun /qoderkey, tap “Set token” and reply with your token. " +
          "Your task text is kept — send it again after storing the token.",
      );
      return;
    }
    const cwd = project?.root ?? process.cwd();
    try {
      const created = await this.app.sessions.create({
        name: `${w.agent} - ${project?.name ?? "adhoc"}`,
        project_id: project?.id ?? null,
        agent: w.agent,
        cwd,
        owner_telegram_user_id: uid,
      });
      await this.app.sessions.start(created.id, task);
      this.st(uid).wizard = undefined;
      this.st(uid).activeSession = created.id;
      const branch = await this.app.git.currentBranch(cwd);
      if (branch) this.app.db.updateSession(created.id, { branch });
      await ctx.reply(
        `✅ Session #${created.id} created\nAgent: ${w.agent}\nProject: ${
          project?.name ?? "(adhoc)"
        }\nStatus: 🟢 working\nChatting now — send messages to talk to the agent.`,
        { reply_markup: this.terminalKb(created.id) },
      );
    } catch (e) {
      await this.fail(ctx, e);
    }
  }

  // ---------- git ----------
  private async gitView(ctx: Context, id: number): Promise<void> {
    const s = this.ownedSession(ctx, id);
    if (!s) {
      await this.deny(ctx);
      return;
    }
    if (!(await this.app.git.isRepo(s.cwd))) {
      await ctx.reply(`Not a git repo: ${s.cwd}`);
      return;
    }
    const st = await this.app.git.status(s.cwd);
    this.st(ctx.from!.id).activeSession = id;
    await ctx.reply(gitStatusText(st), {
      reply_markup: new InlineKeyboard()
        .text("📄 Diff", `git:diff:${id}`).text("📜 Log", `git:log:${id}`).row()
        .text("💾 Commit", `git:commit:${id}`).text("⬆ Push", `git:push:${id}`).row()
        .text("⬅ Back", `sess:${id}`),
    });
  }

  private async handleGitCallback(ctx: Context, parts: string[]): Promise<void> {
    const [, action, idStr] = parts;
    const id = Number(idStr);
    const s: SessionRecord | null = this.ownedSession(ctx, id);
    if (!s) return this.deny(ctx);
    const app = this.app;
    const uid = ctx.from!.id;

    if (action === "diff") {
      const d = await app.git.diff(s.cwd);
      await ctx.reply(
        `📄 Diff\n${d.stat}\n\n${this.clip(this.scrub(d.diff)) || "no changes"}`,
      );
      return;
    }
    if (action === "log") {
      await ctx.reply(`📜 git log\n${await app.git.log(s.cwd)}`);
      return;
    }
    if (action === "commit" || action === "push") {
      const decision = app.policy.decide(`git ${action}`);
      const numstat = await app.git.numstat(s.cwd);
      if (decision !== "allow") {
        const approval = app.approvals.request({
          session_id: id,
          action_type: `git:${action}`,
          payload: { session_id: id, cwd: s.cwd, action, message: "chore: update" },
          actor: `tg:${uid}`,
        });
        app.approvals.registerHandler(`git:${action}`, async (a) => {
          const p = a.payload as { cwd: string; message: string; action: string };
          if (p.action === "commit") {
            await app.git.add(p.cwd);
            await app.git.commit(p.cwd, p.message || "chore: update");
          } else {
            await app.git.push(p.cwd);
          }
        });
        await ctx.reply(
          `⚠️ ${action.toUpperCase()} REQUEST\nRepo: ${s.cwd}\n` +
            `Files: ${numstat.files}  (+${numstat.insertions}/-${numstat.deletions})\n\nApprove?`,
          {
            reply_markup: new InlineKeyboard()
              .text("✅ Approve", `appr:${approval.id}:yes`)
              .text("❌ Cancel", `appr:${approval.id}:no`),
          },
        );
        return;
      }
      if (action === "commit") {
        await app.git.add(s.cwd);
        const r = await app.git.commit(s.cwd, "chore: update");
        await ctx.reply(r.ok ? "💾 Committed." : `❌ ${r.stderr}`);
      } else {
        const r = await app.git.push(s.cwd);
        await ctx.reply(r.ok ? "⬆ Pushed." : `❌ ${r.stderr}`);
      }
    }
  }

  // ---------- per-user Qoder credential ----------
  /**
   * /qoderkey — status (configured/missing/invalid) plus token entry: the user
   * opens the Qoder PAT page, taps "Set token" and replies with the token.
   * Outside that explicit flow a token is still refused in chat; inside it the
   * bot saves the token encrypted and deletes both messages immediately.
   */
  private async qoderKeyCommand(ctx: Context): Promise<void> {
    const uid = ctx.from!.id;
    const status = this.app.credentials.status(uid);
    const lines = [
      "🔑 QODER CREDENTIAL",
      "",
      `Status: ${status}`,
      "",
      "The key is encrypted at rest and injected only into sessions that YOU own.",
      "It is never displayed here, nor in logs, history, notifications or session " +
        "output — only its status is.",
      "",
      "Create, view, or revoke your Qoder Personal Access Tokens (PATs) here:",
      QODER_PAT_URL,
      "",
      "To store or replace your token: tap the button below, then reply with the " +
        "token. Both your message and the prompt are deleted right after saving, " +
        "so the token does not stay in this chat.",
      "",
      "TeleOps keeps ONE encrypted token per account — a new token replaces the " +
      "old one. Token values are never listed.",
    ];
    const kb = new InlineKeyboard();
    kb.text(status === "missing" ? "🔐 Set token" : "🔄 Replace token", "keyset").row();
    if (status !== "missing") kb.text("🗑 Delete my credential", "keydel").row();
    kb.text("⬅ Back", "menu:main");
    await ctx.reply(lines.join("\n"), { reply_markup: kb });
  }

  /** Ask for the token as a chat reply; the next message is treated as the token. */
  private async handleKeySet(ctx: Context): Promise<void> {
    const state = this.st(ctx.from!.id);
    const sent = await ctx.reply(
      "🔐 Send your Qoder token now as a plain message.\n\n" +
        "It is validated, encrypted and saved immediately; I then delete your " +
        "message and this prompt so the token does not remain in chat history.\n" +
        "Type /cancel to abort without saving.",
    );
    state.pendingKeyEntry = { promptMsgId: sent.message_id };
  }

  /**
   * The token entry point the user opted into via "Set token": normalize →
   * optional live probe → encrypted save → delete both messages → confirm.
   * The value is never echoed, logged or forwarded.
   */
  private async handleKeyEntry(ctx: Context, text: string): Promise<void> {
    const app = this.app;
    const uid = ctx.from!.id;
    const state = this.st(uid);
    const prompt = state.pendingKeyEntry;
    if (!prompt) return;
    const key = app.credentials.normalizeKey(text);
    if (key === null) {
      await ctx.reply(
        "❌ That doesn't look like a usable token (8–512 characters, no spaces or " +
          "line breaks). Send the correct token, or /cancel to abort.",
      );
      return;
    }
    if (app.patValidator?.active) {
      const verdict = await app.patValidator.check(key);
      if (verdict.kind === "rejected") {
        await ctx.reply(
          "⛔ Qoder rejected that token — nothing was saved.\n" +
            `Create a new PAT at ${QODER_PAT_URL} and reply again, or /cancel.`,
        );
        return;
      }
    }
    try {
      app.credentials.save(uid, key);
    } catch (e) {
      await this.fail(ctx, e);
      return;
    }
    state.pendingKeyEntry = undefined;
    const chatId = ctx.chat?.id;
    const userMsgId = ctx.msg?.message_id;
    let wiped = true;
    const ids = [userMsgId, prompt.promptMsgId].filter((i): i is number => i != null);
    if (chatId != null) {
      for (const id of ids) {
        try {
          await this.bot.api.deleteMessage(chatId, id);
        } catch {
          wiped = false;
          app.logs.system.warn("could not delete token message — remove it manually");
        }
      }
    } else {
      wiped = false;
    }
    await ctx.reply(
      "✅ Token saved (encrypted at rest). Status: configured.\n" +
        "Your own Qoder sessions will use it; other users are unaffected." +
        (wiped
          ? "\n🧹 The token message and the prompt were deleted."
          : "\n⚠️ I could not delete the messages — remove the token message from this chat manually."),
    );
  }

  /** Deletion asks for explicit confirmation, then removes only this user's key. */
  private async handleKeyDelete(
    ctx: Context,
    verdict: "ask" | "yes" | "no",
  ): Promise<void> {
    const uid = ctx.from!.id;
    const state = this.st(uid);
    if (verdict === "no") {
      state.pendingKeyDelete = undefined;
      await ctx.reply("Cancelled.");
      return;
    }
    if (verdict === "ask") {
      if (this.app.credentials.status(uid) === "missing") {
        await ctx.reply("You have no credential to delete.");
        return;
      }
      state.pendingKeyDelete = true;
      await ctx.reply(
        "⚠️ Delete your Qoder credential? Your own Qoder sessions will not start " +
          "until you set a new token.",
        {
          reply_markup: new InlineKeyboard()
            .text("✅ Yes, delete", "keydel:yes")
            .text("✋ Cancel", "keydel:no"),
        },
      );
      return;
    }
    // callback data is untrusted: deletion only runs after an in-state confirm
    if (!state.pendingKeyDelete) {
      await ctx.reply("Nothing to confirm — run /qoderkey first.");
      return;
    }
    this.app.credentials.remove(uid);
    state.pendingKeyDelete = undefined;
    await ctx.reply("🗑 Credential deleted. Other users' sessions are unaffected.");
  }

  /** Admin visibility: statuses only, never key material. */
  private credentialsStatusText(): string {
    const rows = this.app.credentials.allStatuses();
    if (!rows.length) return "🔑 No user has a Qoder credential yet.";
    return [
      "🔑 QODER CREDENTIALS (statuses only — values are never exposed)",
      "",
      ...rows.map((r) => `  ${r.telegram_user_id}  ${r.status}  ·  ${ago(r.updated_at)}`),
    ].join("\n");
  }

  // ---------- callbacks ----------
  private async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data;
    const ack = async (): Promise<void> => {
      try {
        await ctx.answerCallbackQuery();
      } catch {
        /* noop */
      }
    };
    if (!data) {
      await ack();
      return;
    }
    const uid = ctx.from!.id;
    const app = this.app;
    const parts = data.split(":");

    if (data === "menu:main") {
      await ctx.editMessageText("🤖 AI COMMAND CENTER\nChoose an option:", {
        reply_markup: this.mainMenu(isAdminUser(app, uid)),
      });
      return ack();
    }

    if (data.startsWith("nav:")) {
      switch (parts[1]) {
        case "sessions":
          await this.sessionsOverview(ctx);
          break;
        case "hosts":
          await this.hostsOverview(ctx);
          break;
        case "projects": {
          const ps = isAdminUser(app, uid)
            ? app.db.listProjects()
            : app.db.listProjectsForOwner(uid);
          const lines = ps.map((p) => {
            const host = p.host_id ? app.hosts.getHost(p.host_id) : undefined;
            return `${p.id}. ${p.name}  [${host ? `remote @ ${host.host}` : "local"}]  ${p.root}`;
          });
          await ctx.reply("📁 Projects\n\n" + (lines.join("\n") || "none — /addproject to register"));
          break;
        }
        case "server": {
          if (!(await this.requireAdmin(ctx))) break;
          const counts = this.sessionCounts(uid);
          const full = app.monitor.fullReport
            ? await app.monitor.fullReport().catch(() => null)
            : null;
          await ctx.reply(
            full ? serverStatusExtended(full, counts) : serverStatus(await app.monitor.metrics(), counts),
          );
          break;
        }
        case "processes":
          if (!(await this.requireAdmin(ctx))) break;
          await ctx.reply(processesList(await app.monitor.topProcesses()));
          break;
        case "logs":
          await this.showLogs(ctx, this.st(uid).activeSession);
          break;
        case "health":
          if (!(await this.requireAdmin(ctx))) break;
          await ctx.reply(this.healthText());
          break;
        case "alerts":
          if (!(await this.requireAdmin(ctx))) break;
          await ctx.reply("Use /alerts for the current alert + approval summary.");
          break;
        case "settings":
          if (!(await this.requireAdmin(ctx))) break;
          await ctx.reply(
            "⚙️ Settings\nmax_concurrent: " +
              app.config.sessions.max_concurrent +
              "\nagents: " +
              app.adapters.ids().join(", "),
          );
          break;
        case "qoderkey":
          await this.qoderKeyCommand(ctx);
          break;
        case "git":
          await ctx.reply("Open 🌿 Git from a session, or use /git <session id>.");
          break;
        case "new":
          await this.startWizard(ctx);
          break;
        case "addserver": {
          this.st(uid).serverWizard = { step: "host", draft: {} };
          await ctx.reply("🖥 Add server (1/4)\n\nSend the server address (IP or hostname).\nType /cancel to abort.");
          break;
        }
        case "addproject": {
          const hostId = await this.requireRemote(ctx);
          if (hostId !== null) {
            this.st(uid).projectWizard = true;
            await ctx.reply("📁 Send the absolute project path on the server (e.g. /srv/app).\nType /cancel to abort.");
          }
          break;
        }
      }
      return ack();
    }

    if (data === "keyset") {
      await this.handleKeySet(ctx);
      return ack();
    }

    if (data === "keydel" || data.startsWith("keydel:")) {
      const verdict = parts[1] === "yes" ? "yes" : parts[1] === "no" ? "no" : "ask";
      await this.handleKeyDelete(ctx, verdict);
      return ack();
    }

    if (data.startsWith("hostuse:")) {
      await this.handleHostUse(ctx, Number(parts[1]));
      return ack();
    }

    if (data.startsWith("hostdel:")) {
      await this.handleHostDelete(ctx, Number(parts[1]));
      return ack();
    }

    if (data.startsWith("sess:")) {
      await this.enterChat(ctx, Number(parts[1]));
      return ack();
    }

    if (data.startsWith("proj:")) {
      const pid = Number(parts[1]);
      const p = resolveProject(app, uid, pid);
      if (!p) {
        await this.deny(ctx);
        return ack();
      }
      this.st(uid).wizard = { step: "agent", project_id: pid || undefined };
      const kb = new InlineKeyboard();
      for (const a of app.adapters.ids()) kb.text(a, `agent:${a}`).row();
      await ctx.editMessageText("2/3 select agent:", { reply_markup: kb });
      return ack();
    }

    if (data.startsWith("agent:")) {
      const state = this.st(uid);
      state.wizard = { step: "task", project_id: state.wizard?.project_id, agent: parts[1] };
      await ctx.editMessageText(`3/3 Enter the task for ${parts[1]} (type your message):`);
      return ack();
    }

    if (data.startsWith("act:")) {
      const action = parts[1];
      const id = Number(parts[2]);
      const s = resolveSession(app, uid, id);
      if (!s) {
        await this.deny(ctx);
        return ack();
      }
      switch (action) {
        case "chat":
          await this.enterChat(ctx, id);
          break;
        case "logs": {
          const out = await app.sessions.capture(id, 120);
          await ctx.reply(this.clip(this.scrub(out)) || "(no output)");
          break;
        }
        case "status":
          await ctx.reply(`#${id} ${s.name}: ${s.status} · ${s.agent_type}`);
          break;
        case "summary":
          await ctx.reply(this.summaryText(id));
          break;
        case "history":
          await ctx.reply(await this.historyText(s, HISTORY_DEFAULT_LIMIT));
          break;
        case "git":
          await this.gitView(ctx, id);
          break;
        case "stop":
          await this.safe(() => app.sessions.stop(id), ctx, `⏹ #${id} stopped.`);
          break;
        case "resume":
          await this.safe(() => app.sessions.resume(id), ctx, `▶ #${id} resumed.`);
          break;
      }
      return ack();
    }

    if (data.startsWith("git:")) {
      await this.handleGitCallback(ctx, parts);
      return ack();
    }

    if (data.startsWith("logview:") || data.startsWith("logtail:")) {
      const t = resolveTaskLog(app, uid, Number(parts[1]));
      if (!t) {
        await this.deny(ctx);
        return ack();
      }
      const text = await this.taskLogText(t);
      if (data.startsWith("logview:")) {
        await ctx.reply(text, { reply_markup: this.logButtons(t) });
      } else {
        try {
          await ctx.editMessageText(text);
        } catch {
          await ctx.reply(text, { reply_markup: this.logButtons(t) });
        }
      }
      return ack();
    }

    if (data.startsWith("loglist:")) {
      const s = resolveSession(app, uid, Number(parts[1]));
      if (!s) {
        await this.deny(ctx);
        return ack();
      }
      await this.showLogs(ctx, s.id);
      return ack();
    }

    if (data.startsWith("appr:")) {
      const approval = resolveApproval(app, uid, Number(parts[1]));
      if (!approval) {
        await this.deny(ctx);
        return ack();
      }
      const verdict = parts[2];
      app.approvals.resolve(approval.id, verdict === "yes" ? "APPROVED" : "REJECTED", `tg:${uid}`);
      await ctx.editMessageText(
        `Approval #${approval.id} ${verdict === "yes" ? "✅ approved" : "❌ rejected"}.`,
      );
      return ack();
    }

    if (data.startsWith("agentappr:")) {
      const s = resolveSession(app, uid, Number(parts[1]));
      if (!s) {
        await this.deny(ctx);
        return ack();
      }
      const verdict = parts[2];
      await app.sessions.sendInput(s.id, verdict === "yes" ? "y" : "n");
      await ctx.editMessageText(`Sent "${verdict === "yes" ? "yes" : "no"}" to #${s.id}.`);
      return ack();
    }

    return ack();
  }

  // ---------- notifications + live output ----------
  private wireNotifications(): void {
    const app = this.app;
    app.notifications.registerSink((event: DomainEvent, text: string) => {
      // destination follows the SESSION OWNER (see src/notify/routing.ts) —
      // never "the last chat that said something"
      for (const chatId of notificationChatIds(app, event)) {
        let kb: InlineKeyboard | undefined;
        if (event.type === "APPROVAL_REQUIRED" && event.session_id) {
          kb = new InlineKeyboard()
            .text("✅ Approve", `agentappr:${event.session_id}:yes`)
            .text("❌ Reject", `agentappr:${event.session_id}:no`)
            .row()
            .text("💬 Reply", `sess:${event.session_id}`);
        }
        void this.bot.api
          .sendMessage(chatId, this.scrub(text), { reply_markup: kb })
          .catch(() => undefined);
      }
    });

    app.bus.on("SESSION_OUTPUT", (e) => {
      if (e.session_id) this.scheduleLive(e.session_id, (e.payload?.chunk as string) ?? "");
    });
  }

  private scheduleLive(sessionId: number, chunk: string): void {
    if (!liveOutputTarget(this.app, sessionId)) return;
    this.liveState.set(sessionId, (this.liveState.get(sessionId) ?? "") + "\n" + chunk);
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => {
      void this.flushLive();
    }, 2500);
    this.liveTimer.unref?.();
  }

  private async flushLive(): Promise<void> {
    this.liveTimer = undefined;
    for (const [sessionId, agg] of [...this.liveState]) {
      this.liveState.set(sessionId, "");
      if (!agg.trim()) continue;
      const target = liveOutputTarget(this.app, sessionId);
      if (!target) continue;
      const state = this.st(target.userId);
      const s = this.app.db.getSession(sessionId);
      const text = `🤖 ${s?.agent_type ?? "agent"} #${sessionId}\n━━━━━━━━━━━━━━\n${this.clip(this.scrub(agg))}`;
      let edited = false;
      if (state.liveMessageId) {
        try {
          await this.bot.api.editMessageText(target.chatId, state.liveMessageId, text);
          edited = true;
        } catch {
          /* message gone — send a new one below */
        }
      }
      if (!edited) {
        const m = await this.bot.api.sendMessage(target.chatId, text).catch(() => null);
        if (m) state.liveMessageId = m.message_id;
      }
    }
  }

  async start(): Promise<void> {
    this.wireNotifications();
    this.bot.catch((e) => {
      const err = e.error instanceof Error ? e.error : new Error(String(e.error));
      this.app.tracker.report("telegram", err, { update: e.ctx.update?.update_id });
      this.app.logs.system.error(`telegram handler error: ${err.message}`);
    });
    await this.bot.api.setMyCommands([
      { command: "start", description: "Main menu" },
      { command: "addserver", description: "Connect a remote server (SSH)" },
      { command: "hosts", description: "My servers / pick active server" },
      { command: "addproject", description: "Register a project path on the server" },
      { command: "projects", description: "List my projects" },
      { command: "pwd", description: "Show current project directory" },
      { command: "ls", description: "List current project directory" },
      { command: "cd", description: "Change directory inside a project" },
      { command: "mkdir", description: "Create a directory in my project" },
      { command: "sessions", description: "List my AI sessions" },
      { command: "new", description: "Create a session" },
      { command: "send", description: "Send a message to a session: /send <id> <text>" },
      { command: "qoder", description: "Send raw Qoder input: /qoder <id> <input>" },
      { command: "history", description: "Session history: /history <id> [limit]" },
      { command: "qoderkey", description: "Qoder token: status, set/replace, delete" },
      { command: "logs", description: "Task logs: /logs [session id] [limit]" },
      { command: "git", description: "Git status for a session" },
      { command: "memory", description: "Recent tasks memory of a project" },
      { command: "cancel", description: "Cancel the current wizard" },
      { command: "help", description: "Help" },
    ]);
    await this.bot.start({
      onStart: (me) => this.app.logs.system.info(`bot online: @${me.username}`),
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}

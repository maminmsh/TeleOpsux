import { Bot, InlineKeyboard, Context } from "grammy";
import { App, isAllowedUser } from "../core/container";
import { DomainEvent, SessionRecord, TaskLog } from "../shared/types";
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
}

/**
 * Telegram is a thin View Layer over the core (docs §53/§79). It never touches
 * the shell or tmux directly — everything routes through the Session Manager,
 * Git Manager, Approval and Policy layers.
 */
export class TelegramController {
  private bot: Bot;
  private state = new Map<number, UserState>();
  private primaryChatId: number | null = null;
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

  private st(userId: number): UserState {
    let s = this.state.get(userId);
    if (!s) {
      s = {};
      this.state.set(userId, s);
    }
    return s;
  }

  private projectName(id: number | null): string | undefined {
    return id ? this.app.db.getProject(id)?.name : undefined;
  }

  private sessionCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const s of this.app.db.listSessions())
      counts[s.status] = (counts[s.status] ?? 0) + 1;
    return counts;
  }

  private clip(s: string): string {
    const trimmed = s.replace(/\s+$/g, "");
    return trimmed.length > 3500 ? trimmed.slice(-3500) : trimmed;
  }

  /** Remote-mode gate for features that only make sense against an SSH host. */
  private activeHostId(): number | null {
    return this.app.hosts.getActiveHost()?.id ?? null;
  }

  private async requireRemote(ctx: Context): Promise<number | null> {
    const id = this.activeHostId();
    if (id === null)
      await ctx.reply("🔌 No server connected. Run /addserver first.");
    return id;
  }

  /** Tail the last `bytes` of a file on the current transport. */
  private async tailRemoteFile(path: string, bytes = 3500): Promise<string> {
    const r = await this.app.runner.execScript(`tail -c ${bytes} ${shq(path)}`);
    if (r.code !== 0)
      return `(cannot read log: ${(r.stderr || `exit ${r.code}`).slice(0, 200)})`;
    return this.clip(r.stdout);
  }

  private cancelWizards(uid: number): void {
    const s = this.st(uid);
    s.serverWizard = undefined;
    s.projectWizard = undefined;
    s.wizard = undefined;
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

  private mainMenu(): InlineKeyboard {
    return new InlineKeyboard()
      .text("🧠 Sessions", "nav:sessions").row()
      .text("➕ New Session", "nav:new").row()
      .text("📁 Projects", "nav:projects").text("🌿 Git", "nav:git").row()
      .text("🖥 Server", "nav:server").text("📜 Logs", "nav:logs").row()
      .text("⚠️ Alerts", "nav:alerts").text("🩺 Health", "nav:health").row()
      .text("➕ Add Server", "nav:addserver").text("📁 Add Project", "nav:addproject").row()
      .text("⚙️ Settings", "nav:settings");
  }

  private async sessionsOverview(ctx: Context): Promise<void> {
    const sessions = this.app.db.listSessions();
    const text = sessionsList(sessions, (id) => this.projectName(id));
    const kb = new InlineKeyboard();
    for (const s of sessions) kb.text(`${s.id}. ${s.name}`, `sess:${s.id}`).row();
    kb.text("⬅ Back", "menu:main");
    await ctx.reply(text.length > 4000 ? text.slice(0, 4000) : text, {
      reply_markup: kb,
    });
  }

  private async enterChat(ctx: Context, sessionId: number): Promise<void> {
    const s = this.app.db.getSession(sessionId);
    if (!s) {
      await ctx.reply(`Session #${sessionId} not found.`);
      return;
    }
    this.st(ctx.from!.id).activeSession = sessionId;
    const out = await this.app.sessions.capture(sessionId, 40);
    await ctx.reply(
      `💬 Chatting with ${s.agent_type} #${s.id} (${s.status})\n` +
        `Send any message to forward it to the agent.\n\n` +
        `Recent output:\n${this.clip(out) || "(no output yet)"}`,
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

  private async safe(fn: () => Promise<unknown>, ctx: Context, ok: string): Promise<void> {
    try {
      await fn();
      await ctx.reply(ok);
    } catch (e) {
      await ctx.reply(`❌ ${String((e as Error).message)}`);
    }
  }

  // ---------- registration ----------
  private register(): void {
    const app = this.app;

    this.bot.use(async (ctx, next) => {
      if (ctx.chat?.id) this.primaryChatId = ctx.chat.id;
      if (!this.allowed(ctx)) {
        if (ctx.from) {
          app.logs.system.warn("unauthorized telegram user", { id: ctx.from.id });
          await ctx
            .reply("⛔ Not authorized. Ask the operator to add your Telegram user id to the allowlist.")
            .catch(() => {});
        }
        return;
      }
      await next();
    });

    this.bot.command("start", (ctx) =>
      ctx.reply("🤖 AI COMMAND CENTER\nChoose an option:", { reply_markup: this.mainMenu() }),
    );

    this.bot.command("help", (ctx) =>
      ctx.reply(
        [
          "Commands:",
          "/addserver       connect a remote server (SSH)",
          "/addproject      register a project path on the server",
          "/removeproject <id>",
          "/sessions        list sessions",
          "/new             create a session (remote projects only)",
          "/session <id>    chat with a session",
          "/stop <id> /resume <id> /kill <id>",
          "/summary <id>    rule-based summary",
          "/server          /processes  /alerts  /health",
          "/projects        /memory [project id]",
          "/git <id>        git status for a session",
          "/logs [id]       last task log, or log list for a session",
          "",
          "Core ≠ Telegram: all actions go through the control-plane layers.",
        ].join("\n"),
      ),
    );

    const serverReply = async (ctx: Context) => {
      const counts = this.sessionCounts();
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

    this.bot.command("cancel", (ctx) => {
      this.cancelWizards(ctx.from!.id);
      return ctx.reply("Cancelled.");
    });

    this.bot.command("addproject", async (ctx) => {
      const hostId = await this.requireRemote(ctx);
      if (hostId === null) return;
      const arg = (ctx.match?.[0] ?? "").trim();
      if (arg) {
        await this.registerProject(ctx, hostId, arg);
        return;
      }
      this.st(ctx.from!.id).projectWizard = true;
      await ctx.reply(
        "📁 Send the absolute project path on the server (e.g. /srv/app).\nType /cancel to abort.",
      );
    });

    this.bot.command("removeproject", async (ctx) => {
      const id = Number((ctx.match?.[0] ?? "").trim());
      if (!id) return ctx.reply("Usage: /removeproject <id>");
      const p = app.db.getProject(id);
      if (!p) return ctx.reply(`Project #${id} not found.`);
      const sessions = app.db.listSessions().filter((s) => s.project_id === id);
      if (sessions.some((s) => ["STARTING", "WORKING", "WAITING_INPUT", "WAITING_APPROVAL"].includes(s.status)))
        return ctx.reply(`❌ Project #${id} has active sessions — stop them first.`);
      app.db.deleteProject(id);
      await ctx.reply(`🗑 Project "${p.name}" removed from TeleOps (files on the server are untouched).`);
    });

    this.bot.command("projects", (ctx) => {
      const ps = app.db.listProjects();
      if (!ps.length)
        return ctx.reply(
          app.sessions.remoteMode
            ? "No projects yet. Register one with /addproject."
            : "No projects yet. Connect a server with /addserver, then /addproject.",
        );
      const lines = ps.map((p, i) => {
        const host = p.host_id ? app.hosts.getHost(p.host_id) : undefined;
        const tag = host ? `remote @ ${host.host}` : "local";
        return `${i + 1}. ${p.name}  [${tag}]\n   ${p.root}`;
      });
      return ctx.reply("📁 PROJECTS\n\n" + lines.join("\n\n"));
    });

    this.bot.command("session", async (ctx) => {
      const id = Number((ctx.match?.[0] ?? "").trim());
      if (!id) return ctx.reply("Usage: /session <id>");
      await this.enterChat(ctx, id);
    });

    this.bot.command("processes", async (ctx) =>
      ctx.reply(processesList(await app.monitor.topProcesses())),
    );

    this.bot.command("alerts", (ctx) => {
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

    this.bot.command("health", (ctx) => ctx.reply(this.healthText()));

    this.bot.command("memory", async (ctx) => {
      if (!(await this.requireRemote(ctx))) return;
      const id = Number((ctx.match?.[0] ?? "").trim());
      const hostId = this.activeHostId()!;
      const projects = app.db.listRemoteProjects(hostId);
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

    this.bot.command("settings", (ctx) =>
      ctx.reply(
        `⚙️ SETTINGS\nmax_concurrent: ${app.config.sessions.max_concurrent}\n` +
          `heartbeat: ${app.config.sessions.heartbeat_interval_seconds}s\n` +
          `agents: ${app.adapters.ids().join(", ")}\n` +
          `allowed_users: ${app.config.security.allowed_users.length}`,
      ),
    );

    this.bot.command("logs", (ctx) => this.showLogs(ctx, Number((ctx.match?.[0] ?? "").trim()) || undefined));

    this.bot.command("summary", async (ctx) => {
      const id = Number((ctx.match?.[0] ?? "").trim());
      if (!id) return ctx.reply("Usage: /summary <session id>");
      await ctx.reply(this.summaryText(id));
    });

    this.bot.command("stop", async (ctx) => {
      const id = Number((ctx.match?.[0] ?? "").trim());
      if (!id) return ctx.reply("Usage: /stop <id>");
      await this.safe(() => app.sessions.stop(id), ctx, `⏹ Session #${id} stopped.`);
    });

    this.bot.command("resume", async (ctx) => {
      const id = Number((ctx.match?.[0] ?? "").trim());
      if (!id) return ctx.reply("Usage: /resume <id>");
      await this.safe(() => app.sessions.resume(id), ctx, `▶ Session #${id} resumed.`);
    });

    this.bot.command("kill", async (ctx) => {
      const id = Number((ctx.match?.[0] ?? "").trim());
      if (!id) return ctx.reply("Usage: /kill <id>");
      await this.safe(() => app.sessions.stop(id), ctx, `🛑 Session #${id} killed.`);
    });

    this.bot.command("new", (ctx) => this.startWizard(ctx));

    this.bot.command("git", async (ctx) => {
      const id = Number((ctx.match?.[0] ?? "").trim());
      if (!id) return ctx.reply("Usage: /git <session id>");
      await this.gitView(ctx, id);
    });

    // Plain text → wizard steps, else forward to the active session (docs §7).
    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) return;
      const state = this.st(ctx.from!.id);

      if (state.serverWizard) {
        await this.handleServerWizard(ctx, text);
        return;
      }
      if (state.projectWizard) {
        state.projectWizard = undefined;
        const hostId = this.activeHostId();
        if (hostId === null) return ctx.reply("🔌 No server connected. Run /addserver first.");
        await this.registerProject(ctx, hostId, text.trim());
        return;
      }
      if (state.wizard?.step === "task") {
        await this.finishWizard(ctx, text);
        return;
      }
      if (state.activeSession) {
        try {
          await app.sessions.sendInput(state.activeSession, text);
          const out = await app.sessions.capture(state.activeSession, 30);
          await ctx.reply(`⏳ ${this.clip(out) || "sent"}`);
        } catch (e) {
          await ctx.reply(`❌ ${String((e as Error).message)}`);
        }
        return;
      }
      await ctx.reply("Open a session with /sessions or /session <id>, then chat here.");
    });

    this.bot.on("callback_query:data", (ctx) => this.handleCallback(ctx));
  }

  // ---------- server wizard ----------
  private async handleServerWizard(ctx: Context, text: string): Promise<void> {
    const app = this.app;
    const state = this.st(ctx.from!.id);
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

    // step "pass" — test, then persist + hot switch
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
      saved = app.hosts.addHost({ host: host!, port: port!, username: username!, password: value, activate: true });
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
  }

  // ---------- project registration ----------
  private async registerProject(ctx: Context, hostId: number, rawPath: string): Promise<void> {
    const app = this.app;
    const path = rawPath.replace(/\/+$/, "");
    if (!path.startsWith("/") || path.length < 2) {
      await ctx.reply("❌ Path must be absolute on the server (e.g. /srv/app).");
      return;
    }
    if (/[\x00-\x1f]/.test(path)) {
      await ctx.reply("❌ Invalid characters in path.");
      return;
    }

    const exists = await app.runner.exec("test", ["-d", path]);
    if (exists.code !== 0) {
      await ctx.reply(`❌ Directory not found on the server: ${path}\n(${exists.stderr.slice(0, 200)})`);
      return;
    }

    const dup = app.db
      .listRemoteProjects(hostId)
      .find((p) => p.root.replace(/\/+$/, "") === path);
    if (dup) {
      await ctx.reply(`ℹ️ Already registered as project #${dup.id} "${dup.name}".`);
      return;
    }

    const isRepo = await app.git.isRepo(path);
    const project = app.db.createProject(basename(path), path, hostId);
    await ctx.reply(
      `📁 Project #${project.id} "${project.name}" registered → ${path}\n` +
        (isRepo ? "Git repository: ✅ yes" : "⚠️ Not a git repository — /git will not work for sessions here."),
    );
  }

  // ---------- task logs ----------
  private async taskLogText(t: TaskLog): Promise<string> {
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

  private async showLogs(ctx: Context, sessionId?: number): Promise<void> {
    const app = this.app;
    if (sessionId === undefined) {
      const latest = app.db.listTaskLogs({}, 1)[0];
      if (!latest) {
        await ctx.reply("📜 No task logs yet. Logs are recorded when a session starts in a registered project.");
        return;
      }
      await ctx.reply(await this.taskLogText(latest), { reply_markup: this.logButtons(latest) });
      return;
    }
    const session = app.db.getSession(sessionId);
    if (!session) {
      await ctx.reply(`Session #${sessionId} not found.`);
      return;
    }
    const logs = app.db.listTaskLogs({ session_id: sessionId }, 10);
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
    const hostId = this.activeHostId();
    if (hostId === null) {
      await ctx.reply("🔌 Sessions run on a registered server project. Connect one with /addserver, then /addproject.");
      return;
    }
    const kb = new InlineKeyboard();
    const projects = this.app.db.listRemoteProjects(hostId);
    if (!projects.length) {
      await ctx.reply("📁 No projects on this server yet. Register one with /addproject <path>.");
      return;
    }
    for (const p of projects) kb.text(p.name, `proj:${p.id}`).row();
    this.st(ctx.from!.id).wizard = { step: "agent" };
    await ctx.reply("New session — 1/3 select project:", { reply_markup: kb });
  }

  private async finishWizard(ctx: Context, task: string): Promise<void> {
    const uid = ctx.from!.id;
    const w = this.st(uid).wizard;
    if (!w?.agent) return;
    const project = w.project_id ? this.app.db.getProject(w.project_id) : undefined;
    const cwd = project?.root ?? process.cwd();
    try {
      const created = await this.app.sessions.create({
        name: `${w.agent} - ${project?.name ?? "adhoc"}`,
        project_id: project?.id ?? null,
        agent: w.agent,
        cwd,
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
      );
    } catch (e) {
      await ctx.reply(`❌ ${String((e as Error).message)}`);
    }
  }

  // ---------- git ----------
  private async gitView(ctx: Context, id: number): Promise<void> {
    const s = this.app.db.getSession(id);
    if (!s) {
      await ctx.reply(`Session #${id} not found.`);
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
    const s: SessionRecord | undefined = this.app.db.getSession(id);
    if (!s) return;
    const app = this.app;
    const uid = ctx.from!.id;

    if (action === "diff") {
      const d = await app.git.diff(s.cwd);
      await ctx.reply(
        `📄 Diff\n${d.stat}\n\n${this.clip(d.diff) || "no changes"}`,
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
        reply_markup: this.mainMenu(),
      });
      return ack();
    }

    if (data.startsWith("nav:")) {
      switch (parts[1]) {
        case "sessions":
          await this.sessionsOverview(ctx);
          break;
        case "projects": {
          const ps = app.db.listProjects();
          const lines = ps.map((p) => {
            const host = p.host_id ? app.hosts.getHost(p.host_id) : undefined;
            return `${p.id}. ${p.name}  [${host ? `remote @ ${host.host}` : "local"}]  ${p.root}`;
          });
          await ctx.reply("📁 Projects\n\n" + (lines.join("\n") || "none — /addproject to register"));
          break;
        }
        case "server": {
          const counts = this.sessionCounts();
          const full = app.monitor.fullReport
            ? await app.monitor.fullReport().catch(() => null)
            : null;
          await ctx.reply(
            full ? serverStatusExtended(full, counts) : serverStatus(await app.monitor.metrics(), counts),
          );
          break;
        }
        case "processes":
          await ctx.reply(processesList(await app.monitor.topProcesses()));
          break;
        case "logs":
          await this.showLogs(ctx, this.st(uid).activeSession);
          break;
        case "health":
          await ctx.reply(this.healthText());
          break;
        case "alerts":
          await ctx.reply("Use /alerts for the current alert + approval summary.");
          break;
        case "settings":
          await ctx.reply(
            "⚙️ Settings\nmax_concurrent: " +
              app.config.sessions.max_concurrent +
              "\nagents: " +
              app.adapters.ids().join(", "),
          );
          break;
        case "git":
          await ctx.reply("Open 🌿 Git from a session, or use /git <session id>.");
          break;
        case "new":
          await this.startWizard(ctx);
          break;
        case "health":
          await ctx.reply(this.healthText());
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

    if (data.startsWith("sess:")) {
      await this.enterChat(ctx, Number(parts[1]));
      return ack();
    }

    if (data.startsWith("proj:")) {
      const pid = Number(parts[1]);
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
      switch (action) {
        case "chat":
          await this.enterChat(ctx, id);
          break;
        case "logs": {
          const out = await app.sessions.capture(id, 120);
          await ctx.reply(this.clip(out) || "(no output)");
          break;
        }
        case "status": {
          const s = app.db.getSession(id);
          await ctx.reply(s ? `#${id} ${s.name}: ${s.status} · ${s.agent_type}` : "not found");
          break;
        }
        case "summary":
          await ctx.reply(this.summaryText(id));
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
      const t = app.db.getTaskLog(Number(parts[1]));
      if (!t) {
        await ctx.reply("Task log not found.");
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
      await this.showLogs(ctx, Number(parts[1]));
      return ack();
    }

    if (data.startsWith("appr:")) {
      const verdict = parts[2];
      app.approvals.resolve(Number(parts[1]), verdict === "yes" ? "APPROVED" : "REJECTED", `tg:${uid}`);
      await ctx.editMessageText(
        `Approval #${parts[1]} ${verdict === "yes" ? "✅ approved" : "❌ rejected"}.`,
      );
      return ack();
    }

    if (data.startsWith("agentappr:")) {
      const verdict = parts[2];
      await app.sessions.sendInput(Number(parts[1]), verdict === "yes" ? "y" : "n");
      await ctx.editMessageText(`Sent "${verdict === "yes" ? "yes" : "no"}" to #${parts[1]}.`);
      return ack();
    }

    return ack();
  }

  // ---------- notifications + live output ----------
  private wireNotifications(): void {
    const app = this.app;
    app.notifications.registerSink((event: DomainEvent, text: string) => {
      const chatId = this.primaryChatId;
      if (!chatId) return;
      let kb: InlineKeyboard | undefined;
      if (event.type === "APPROVAL_REQUIRED" && event.session_id) {
        kb = new InlineKeyboard()
          .text("✅ Approve", `agentappr:${event.session_id}:yes`)
          .text("❌ Reject", `agentappr:${event.session_id}:no`)
          .row()
          .text("💬 Reply", `sess:${event.session_id}`);
      }
      void this.bot.api
        .sendMessage(chatId, text, { reply_markup: kb })
        .catch(() => undefined);
    });

    app.bus.on("SESSION_OUTPUT", (e) => {
      if (e.session_id) this.scheduleLive(e.session_id, (e.payload?.chunk as string) ?? "");
    });
  }

  private scheduleLive(sessionId: number, chunk: string): void {
    const user = [...this.state.entries()].find(([, s]) => s.activeSession === sessionId);
    if (!user) return;
    this.liveState.set(sessionId, (this.liveState.get(sessionId) ?? "") + "\n" + chunk);
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => {
      void this.flushLive(sessionId);
    }, 2500);
    this.liveTimer.unref?.();
  }

  private async flushLive(sessionId: number): Promise<void> {
    this.liveTimer = undefined;
    const agg = this.liveState.get(sessionId);
    this.liveState.set(sessionId, "");
    const entry = [...this.state.entries()].find(([, s]) => s.activeSession === sessionId);
    if (!agg?.trim() || !this.primaryChatId || !entry) return;
    const state = entry[1];
    const s = this.app.db.getSession(sessionId);
    const text = `🤖 ${s?.agent_type ?? "agent"} #${sessionId}\n━━━━━━━━━━━━━━\n${this.clip(agg)}`;
    try {
      if (state.liveMessageId) {
        await this.bot.api.editMessageText(this.primaryChatId, state.liveMessageId, text);
        return;
      }
      const m = await this.bot.api.sendMessage(this.primaryChatId, text);
      state.liveMessageId = m.message_id;
    } catch {
      const m = await this.bot.api.sendMessage(this.primaryChatId, text).catch(() => null);
      if (m) state.liveMessageId = m.message_id;
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
      { command: "addproject", description: "Register a project path on the server" },
      { command: "projects", description: "List projects" },
      { command: "sessions", description: "List AI sessions" },
      { command: "new", description: "Create a session" },
      { command: "server", description: "Extended server status" },
      { command: "logs", description: "Last task log (/logs [session id])" },
      { command: "git", description: "Git status for a session" },
      { command: "memory", description: "Recent tasks memory of a project" },
      { command: "health", description: "Per-module error health" },
      { command: "alerts", description: "Alerts & approvals" },
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

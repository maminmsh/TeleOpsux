import { Bot, InlineKeyboard, Context } from "grammy";
import { App } from "../core/container";
import { DomainEvent, SessionRecord } from "../shared/types";
import {
  ago,
  agoFa,
  gitStatusText,
  processesList,
  serverStatus,
  serverStatusExtended,
  sessionsList,
  statusFarsi,
} from "./format";
import { ACTIVE_STATUSES } from "../session/state-machine";
import { shq } from "../exec/exec-runner";
import { basename } from "../shared/paths";
import path from "node:path";
import fs from "node:fs";
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
import { storedHistoryLines } from "../web/output-hub";
import {
  CREDENTIAL_REQUIRED_MESSAGE,
  CredentialRequiredError,
} from "../credentials/credential-service";

interface Wizard {
  step: "project" | "agent" | "task";
  project_id?: number;
  agent?: string;
  /** finishWizard is mid-launch — a second task message must not double-start. */
  busy?: boolean;
}

interface ServerWizard {
  step: "name" | "host" | "port" | "user" | "auth_type" | "credential" | "pass";
  draft: {
    name?: string;
    host?: string;
    port?: number;
    username?: string;
    auth_type?: "password" | "key";
  };
}

interface SessionCreationWizard {
  step: "server" | "project" | "mode" | "name" | "task";
  hostId?: number;
  projectId?: number;
  agent?: string;
  name?: string;
}

interface UserState {
  activeSession?: number;
  wizard?: Wizard;
  serverWizard?: ServerWizard;
  projectWizard?: boolean | { hostId?: number };
  sessionWizard?: SessionCreationWizard;
  pendingRename?: { type: "server" | "project" | "session"; id: number };
  pendingInput?: { sessionId: number };
  liveMessageId?: number;
  /**
   * The ONE persistent navigation message. Menu screens are EDITED in place
   * (never re-sent), so browsing never floods the chat. Recorded by
   * chat+message so edits survive even when the tap came from elsewhere.
   */
  dashboard?: { chatId: number; messageId: number; key: string };
  /** Keys of screens we came from — ⬅ Back pops and re-renders them. */
  navStack?: string[];
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
  private lastUserTap = new Map<number, number>();
  private lastUserData = new Map<number, string>();

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
      const persisted = this.app.db.getUserDashboard?.(userId);
      s = {
        dashboard: persisted
          ? { chatId: persisted.chat_id, messageId: persisted.message_id, key: persisted.screen_key }
          : undefined,
        navStack: persisted?.nav_stack ? JSON.parse(persisted.nav_stack) : [],
      };
      this.state.set(userId, s);
    }
    return s;
  }

  // ---------- dashboard navigation (one edited message) ----------

  /** Telegram replies "message is not modified" when content is identical — not an error. */
  private static isNotModified(e: unknown): boolean {
    const err = e as { error_code?: number; description?: string };
    return (
      err?.error_code === 400 &&
      (err.description ?? "").toLowerCase().includes("not modified")
    );
  }

  private navFooter(kb: InlineKeyboard, showBack = true, showMain = true): InlineKeyboard {
    const row = kb.row();
    if (showBack) row.text("⬅️ بازگشت", "back");
    if (showMain) row.text("🏠 منوی اصلی", "menu:main");
    return kb;
  }

  /**
   * Render a navigation screen WITHOUT flooding the chat: edit the tapped
   * message (the dashboard the button lives on) when possible, else edit the
   * stored dashboard message, else send one new message and store it. The
   * stored chat+message id makes "Back" and refresh EDIT the same bubble.
   */
  private async screen(
    ctx: Context,
    key: string,
    text: string,
    kb?: InlineKeyboard,
  ): Promise<void> {
    const state = this.st(ctx.from!.id);
    const opts = kb ? { reply_markup: kb } : undefined;
    const cbMsg = ctx.callbackQuery && "message" in ctx.callbackQuery
      ? ctx.callbackQuery.message
      : undefined;
    if (cbMsg) {
      try {
        await ctx.editMessageText(text, opts);
        state.dashboard = { chatId: cbMsg.chat.id, messageId: cbMsg.message_id, key };
        this.persistDashboard(ctx.from!.id, state);
        return;
      } catch (e) {
        // "message is not modified" means the dashboard ALREADY shows this
        // screen — done. Anything else (edited too old? not ours to edit?)
        // falls through to the recorded/refresh path below.
        if (TelegramController.isNotModified(e)) {
          state.dashboard = {
            chatId: cbMsg.chat.id,
            messageId: cbMsg.message_id,
            key,
          };
          this.persistDashboard(ctx.from!.id, state);
          return;
        }
      }
    }
    const dash = state.dashboard;
    if (dash) {
      try {
        await this.bot.api.editMessageText(dash.chatId, dash.messageId, text, opts);
        dash.key = key;
        this.persistDashboard(ctx.from!.id, state);
        return;
      } catch (e) {
        if (TelegramController.isNotModified(e)) {
          dash.key = key;
          this.persistDashboard(ctx.from!.id, state);
          return;
        }
        state.dashboard = undefined; // deleted / no longer editable
      }
    }
    const chatId = ctx.chat?.id ?? dash?.chatId;
    if (!chatId) return;
    try {
      const sent = await ctx.reply(text, opts);
      state.dashboard = { chatId, messageId: sent.message_id, key };
      this.persistDashboard(ctx.from!.id, state);
    } catch {
      /* chat unavailable (bot blocked) — nothing sane left to do */
    }
  }

  private persistDashboard(userId: number, state: UserState): void {
    if (state.dashboard) {
      try {
        this.app.db.upsertUserDashboard?.(
          userId,
          state.dashboard.chatId,
          state.dashboard.messageId,
          state.dashboard.key,
          JSON.stringify(state.navStack ?? []),
        );
      } catch {}
    }
  }

  /**
   * Navigate to a screen key. Keeps a per-user back-stack of the screens we
   * came from; "main" is the root and clears it. Non-dashboard keys (wizards,
   * forms) are simply not handled here.
   */
  private async navigate(ctx: Context, uid: number, key: string): Promise<void> {
    const state = this.st(uid);
    const ADMIN_SCREENS = new Set(["server", "processes", "health", "alerts", "settings"]);
    if (ADMIN_SCREENS.has(key) && !(await this.requireAdmin(ctx))) return;
    const spec = await this.screenSpec(ctx, uid, key);
    if (!spec) return;
    const prev = state.dashboard?.key;
    if (key === "main") state.navStack = [];
    else if (prev && prev !== key)
      state.navStack = [...(state.navStack ?? []), prev].slice(-12);
    await this.screen(ctx, key, spec.text, spec.kb);
  }

  /** One Back step: pop the stored screen key and re-render it (default: main). */
  private async goBack(ctx: Context, uid: number): Promise<void> {
    const state = this.st(uid);
    const stack = state.navStack ?? [];
    const prev = stack.at(-1) ?? "main";
    state.navStack = stack.slice(0, -1);
    // Re-render WITHOUT pushing — we are stepping back, not deeper.
    const spec = await this.screenSpec(ctx, uid, prev);
    if (spec) {
      await this.screen(ctx, prev, spec.text, spec.kb);
      return;
    }
    await this.navigate(ctx, uid, prev);
  }

  /** Text + keyboard for a dashboard screen key. */
  private async screenSpec(
    ctx: Context,
    uid: number,
    key: string,
  ): Promise<{ text: string; kb?: InlineKeyboard } | undefined> {
    const app = this.app;
    if (key === "main") {
      return {
        text: "🤖 AI COMMAND CENTER\n\nبه مرکز مدیریت و کنترل TeleOps خوش آمدید.\nجهت دسترسی به بخش‌های مختلف از دکمه‌های زیر استفاده کنید:",
        kb: this.mainMenu(isAdminUser(app, uid)),
      };
    }
    if (key === "sessions") return this.sessionsSpec(uid);
    if (key === "hosts") return this.hostsSpec(uid);
    if (key.startsWith("hostdetail:")) {
      const id = Number(key.split(":")[1]);
      return this.hostDetailSpec(uid, id);
    }
    if (key.startsWith("hostdelreq:")) {
      const id = Number(key.split(":")[1]);
      return this.hostDelReqSpec(uid, id);
    }
    if (key === "projects") {
      const ps = isAdminUser(app, uid)
        ? app.db.listProjects()
        : app.db.listProjectsForOwner(uid);
      const defProjId = app.db.getUserDefaultProjectId?.(uid);
      const kb = new InlineKeyboard();
      kb.text("➕ ثبت پروژه جدید", "projnew:start").row();
      if (!ps.length) {
        this.navFooter(kb, true, true);
        return {
          text: "📁 پروژه‌ها (Projects)\n\nهیچ پروژه‌ای هنوز ثبت نشده است.\nبرای شروع، دکمه «ثبت پروژه جدید» را بزنید.",
          kb,
        };
      }
      const lines = ps.map((p) => {
        const host = p.host_id ? app.hosts.getHost(p.host_id) : undefined;
        const isDef = p.id === defProjId;
        const marker = isDef ? "⭐" : "▫️";
        kb.text(`${marker} ${p.name} [${host ? host.name : "local"}]`, `projdetail:${p.id}`).row();
        return `${marker} #${p.id} ${p.name}\n   └ سرور: ${host ? `${host.name} (${host.host})` : "لوکال"}\n   └ مسیر: ${p.root}`;
      });
      this.navFooter(kb, true, true);
      return {
        text: "📁 مدیریت پروژه‌ها (Projects)\n\n" + lines.join("\n\n") + "\n\nجهت مشاهده جزئیات یا سشن‌ها روی پروژه کلیک کنید:",
        kb,
      };
    }
    if (key.startsWith("projdetail:")) {
      const id = Number(key.split(":")[1]);
      return this.projDetailSpec(uid, id);
    }
    if (key.startsWith("projdelreq:")) {
      const id = Number(key.split(":")[1]);
      return this.projDelReqSpec(uid, id);
    }
    if (key.startsWith("sess:")) {
      const id = Number(key.split(":")[1]);
      const s = resolveSession(app, uid, id);
      if (!s) return undefined;
      const out = await app.sessions.capture(id, 40);
      const kb = this.sessionKb(id);
      this.navFooter(kb, true, true);
      return {
        text:
          `💬 سشن #${s.id}: ${s.name}\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `• وضعیت: ${statusFarsi(s.status)} (${s.status})\n` +
          `• ایجنت: ${s.agent_type}\n` +
          `• پروژه: ${this.projectName(s.project_id) ?? "—"}\n` +
          `• آخرین فعالیت: ${agoFa(s.updated_at)}\n\n` +
          `Recent output:\n${this.clip(this.scrub(out)) || "(no output yet)"}`,
        kb,
      };
    }
    if (key.startsWith("delreq:")) {
      const id = Number(key.split(":")[1]);
      const s = resolveSession(app, uid, id);
      if (!s) return undefined;
      const kb = new InlineKeyboard()
        .text("✅ Yes, delete", `del:${id}`)
        .text("⬅ Cancel", `sess:${id}`);
      return {
        text:
          `⚠️ Delete session #${id} (${this.scrub(s.name)})?\n` +
          `This stops the agent, closes the shell and removes ALL stored history. Cannot be undone.`,
        kb,
      };
    }
    if (key === "logs") return this.logsMenuSpec(uid);
    if (key.startsWith("logsview:")) {
      const type = key.split(":")[1] || "system";
      return this.logsViewSpec(uid, type);
    }
    if (key === "settings") return this.settingsMenuSpec(uid);
    if (key.startsWith("set:")) {
      const type = key.split(":")[1] || "info";
      return this.settingsSubSpec(uid, type);
    }
    if (key === "server") {
      const counts = this.sessionCounts(uid);
      const full = app.monitor.fullReport ? await app.monitor.fullReport().catch(() => null) : null;
      const kb = this.navFooter(new InlineKeyboard(), true, true);
      return {
        text: full ? serverStatusExtended(full, counts) : serverStatus(await app.monitor.metrics(), counts),
        kb,
      };
    }
    if (key === "processes") {
      const kb = this.navFooter(new InlineKeyboard(), true, true);
      return { text: processesList(await app.monitor.topProcesses()), kb };
    }
    if (key === "health") {
      const kb = this.navFooter(new InlineKeyboard(), true, true);
      return { text: this.healthText(), kb };
    }
    if (key === "alerts") {
      const kb = this.navFooter(new InlineKeyboard(), true, true);
      return { text: "Use /alerts for the current alert + approval summary.", kb };
    }
    if (key === "qoderkey") return this.qoderKeySpec(uid);
    return undefined;
  }

  /**
   * The three per-session actions shown right where a session is selected:
   * 🖥 Live (Mini App terminal), 📜 Last 50 lines (stored output) and
   * 🗑 Delete. Telegram's Bot API does NOT let a bot open a Mini App by
   * itself — the user taps the button; that is the compliant maximum. The
   * session id in the URL is only a NON-SECRET selector; the server
   * authorizes with initData + ownership on every call. The web_app button
   * disappears entirely when webapp.url is not configured; the other two
   * actions are plain bot callbacks and always available.
   */
  private sessionKb(sessionId: number): InlineKeyboard {
    const kb = new InlineKeyboard();
    const cfg = this.app.config.webapp;
    if (cfg.enabled && cfg.url) {
      const sep = cfg.url.includes("?") ? "&" : "?";
      kb.webApp("🖥 Live Session Terminal", `${cfg.url}${sep}session=${sessionId}`).row();
    }
    const s = this.app.db.getSession(sessionId);
    const isStopped = s?.status === "STOPPED";
    kb.text("📜 Last 50 lines", `hist50:${sessionId}`)
      .text("🔄 بروزرسانی خروجی", `sessrefresh:${sessionId}`).row()
      .text("⌨️ ارسال ورودی", `sessin:${sessionId}`)
      .text("🛑 ارسال Ctrl+C", `sessctrlc:${sessionId}`).row()
      .text(isStopped ? "▶ ادامه سشن" : "⏹ توقف سشن", isStopped ? `sessresume:${sessionId}` : `sessstopreq:${sessionId}`)
      .text("🌿 وضعیت Git", `git:${sessionId}`).row()
      .text("📋 لاگ‌های تسک", `loglist:${sessionId}`)
      .text("✏️ تغییر نام سشن", `sessrename:${sessionId}`).row()
      .text("🗑 Delete session", `delreq:${sessionId}`);
    return kb;
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

  private mainMenu(_admin?: boolean): InlineKeyboard {
    return new InlineKeyboard()
      .text("🖥 سرورها", "nav:hosts")
      .text("📁 پروژه‌ها", "nav:projects").row()
      .text("🧩 سشن‌ها", "nav:sessions")
      .text("📜 لاگ‌ها", "nav:logs").row()
      .text("⚙️ تنظیمات", "nav:settings");
  }

  private sessionsSpec(uid: number): { text: string; kb: InlineKeyboard } {
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
    for (const s of sessions) {
      const statusIcon = s.status === "WORKING" ? "🟢" : s.status === "STOPPED" ? "⏹" : s.status === "ERROR" || s.status === "CRASHED" ? "🔴" : "🟡";
      kb.text(`${statusIcon} #${s.id} ${s.name}`, `sess:${s.id}`).row();
    }
    kb.text("➕ ایجاد سشن جدید", "sessnew:start").row();
    const cfg = this.app.config.webapp;
    if (cfg.enabled && cfg.url) {
      const sep = cfg.url.includes("?") ? "&" : "?";
      kb.webApp("🖥 Linux Terminal", `${cfg.url}${sep}tab=terminal`).row();
    }
    this.navFooter(kb, true, true);
    return { text: text.length > 4000 ? text.slice(0, 4000) : text, kb };
  }

  private async sessionsOverview(ctx: Context): Promise<void> {
    await this.navigate(ctx, ctx.from!.id, "sessions");
  }

  private async enterChat(ctx: Context, sessionId: number): Promise<void> {
    const s = this.ownedSession(ctx, sessionId);
    if (!s) {
      // unknown id and someone else's id produce the SAME generic refusal
      await this.deny(ctx);
      return;
    }
    const uid = ctx.from!.id;
    const state = this.st(uid);
    state.activeSession = sessionId;
    const out = await this.app.sessions.capture(sessionId, 40);
    const key = `sess:${sessionId}`;
    const prev = state.dashboard?.key;
    if (prev && prev !== key)
      state.navStack = [...(state.navStack ?? []), prev].slice(-12);
    const kb = this.sessionKb(sessionId);
    this.navFooter(kb, true, true);
    await this.screen(
      ctx,
      key,
      `💬 سشن #${s.id}: ${s.name}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `• وضعیت: ${statusFarsi(s.status)} (${s.status})\n` +
        `• ایجنت: ${s.agent_type}\n` +
        `• پروژه: ${this.projectName(s.project_id) ?? "—"}\n` +
        `• شاخه Git: ${s.branch ?? "—"}\n` +
        `• آخرین فعالیت: ${agoFa(s.updated_at)}\n\n` +
        `خروجی اخیر (Recent output):\n${this.clip(this.scrub(out)) || "(بدون خروجی)"}`,
      kb,
    );
  }

  private async hostDetailSpec(uid: number, hostId: number): Promise<{ text: string; kb: InlineKeyboard } | undefined> {
    const host = resolveHost(this.app, uid, hostId);
    if (!host) return undefined;
    const active = this.hostIdForUser(uid);
    const isAct = host.id === active;
    const projects = this.app.db.listRemoteProjects(host.id).filter((p) => projectVisibleTo(this.app, uid, p));
    const allSessions = isAdminUser(this.app, uid) ? this.app.db.listSessions() : this.app.db.listSessionsForOwner(uid);
    const hostSessions = allSessions.filter((s) => s.project_id && projects.some((p) => p.id === s.project_id));
    const kb = new InlineKeyboard();
    kb.text("⚡ تست اتصال SSH", `hosttest:${host.id}`)
      .text(isAct ? "⭐ سرور فعال است" : "⭐ انتخاب به‌عنوان فعال", `hostuse:${host.id}`).row()
      .text(`📁 پروژه‌ها (${projects.length})`, `hostprojs:${host.id}`)
      .text(`🧩 سشن‌ها (${hostSessions.length})`, `hostsess:${host.id}`).row()
      .text("✏️ تغییر نام سرور", `hostrename:${host.id}`)
      .text("🗑 حذف سرور", `hostdelreq:${host.id}`).row();
    this.navFooter(kb, true, true);

    const authLabel = host.auth_type === "key" ? "🔑 کلید اختصاصی SSH (Private Key)" : "🔒 رمز عبور (Password)";
    const connStatus = host.last_connected_at ? `✅ آخرین اتصال: ${agoFa(host.last_connected_at)}` : "⚪ هنوز بررسی نشده";
    const lastErr = host.last_error ? `\n⚠️ خطای آخر اتصال: ${host.last_error}` : "";

    const text =
      `🖥 مشخصات سرور: ${host.name}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `• شناسه: #${host.id}\n` +
      `• آدرس سرور: ${host.host}:${host.port}\n` +
      `• نام کاربری: ${host.username}\n` +
      `• شیوه احراز هویت: ${authLabel}\n` +
      `• وضعیت پیش‌فرض: ${isAct ? "⭐ سرور جاری شما" : "خیر"}\n` +
      `• وضعیت ارتباط: ${connStatus}${lastErr}\n` +
      `• پروژه‌های مرتبط: ${projects.length}\n` +
      `• سشن‌های فعال: ${hostSessions.filter((s) => ACTIVE_STATUSES.includes(s.status)).length} از ${hostSessions.length}`;

    return { text, kb };
  }

  private hostDelReqSpec(uid: number, hostId: number): { text: string; kb: InlineKeyboard } | undefined {
    const host = resolveHost(this.app, uid, hostId);
    if (!host) return undefined;
    const projects = this.app.db.listRemoteProjects(host.id).filter((p) => projectVisibleTo(this.app, uid, p));
    const allSessions = isAdminUser(this.app, uid) ? this.app.db.listSessions() : this.app.db.listSessionsForOwner(uid);
    const activeSessions = allSessions.filter(
      (s) => s.project_id && projects.some((p) => p.id === s.project_id) && ACTIVE_STATUSES.includes(s.status),
    );
    const kb = new InlineKeyboard();
    kb.text("✅ بله، سرور حذف شود", `hostdel:${host.id}`)
      .text("❌ انصراف", `hostdetail:${host.id}`).row();
    this.navFooter(kb, true, true);

    let warning = "";
    if (activeSessions.length > 0) {
      warning = `\n\n⚠️ هشدار: ${activeSessions.length} سشن فعال روی پروژه‌های این سرور در حال اجرا هستند! ابتدا آن‌ها را متوقف کنید.`;
    }

    const text =
      `⚠️ تأیید حذف سرور "${host.name}" (#${host.id})\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `آیا از حذف این سرور از سامانه TeleOps اطمینان دارید؟\n\n` +
      `🛡 توجه ایمنی: حذف رکورد سرور فقط تنظیمات ذخیره‌شده در TeleOps را حذف می‌کند و هیچ‌گونه فایل، پروژه، پوشه یا اطلاعاتی از سیستم مقصد لینوکس حذف نخواهد شد.${warning}`;

    return { text, kb };
  }

  private async projDetailSpec(uid: number, projId: number): Promise<{ text: string; kb: InlineKeyboard } | undefined> {
    const p = resolveProject(this.app, uid, projId);
    if (!p) return undefined;
    const host = p.host_id ? this.app.hosts.getHost(p.host_id) : undefined;
    const defProjId = this.app.db.getUserDefaultProjectId?.(uid);
    const isDef = p.id === defProjId;
    const allSessions = isAdminUser(this.app, uid) ? this.app.db.listSessions() : this.app.db.listSessionsForOwner(uid);
    const projSessions = allSessions.filter((s) => s.project_id === p.id);
    const activeCount = projSessions.filter((s) => ACTIVE_STATUSES.includes(s.status)).length;

    const kb = new InlineKeyboard();
    kb.text("🧩 سشن جدید برای این پروژه", `sessnew:prj:${p.host_id ?? 0}:${p.id}`).row()
      .text("🔍 بررسی وضعیت مسیر و Git", `projcheck:${p.id}`)
      .text(isDef ? "⭐ پروژه پیش‌فرض است" : "⭐ انتخاب به عنوان پیش‌فرض", `projdef:${p.id}`).row()
      .text("✏️ تغییر نام پروژه", `projrename:${p.id}`)
      .text("🗑 حذف ثبت پروژه", `projdelreq:${p.id}`).row();
    this.navFooter(kb, true, true);

    const text =
      `📁 مشخصات پروژه: ${p.name}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `• شناسه: #${p.id}\n` +
      `• سرور میزبان: ${host ? `${host.name} (${host.host}:${host.port})` : "لوکال (TeleOps Host)"}\n` +
      `• مسیر روی سرور: ${p.root}\n` +
      `• توضیحات: ${p.description || "—"}\n` +
      `• پروژه پیش‌فرض: ${isDef ? "⭐ بله" : "خیر"}\n` +
      `• سشن‌های فعال: ${activeCount} از ${projSessions.length}\n` +
      `• تاریخ ثبت: ${agoFa(p.created_at)}`;

    return { text, kb };
  }

  private projDelReqSpec(uid: number, projId: number): { text: string; kb: InlineKeyboard } | undefined {
    const p = resolveProject(this.app, uid, projId);
    if (!p) return undefined;
    const allSessions = isAdminUser(this.app, uid) ? this.app.db.listSessions() : this.app.db.listSessionsForOwner(uid);
    const activeSessions = allSessions.filter((s) => s.project_id === p.id && ACTIVE_STATUSES.includes(s.status));

    const kb = new InlineKeyboard();
    kb.text("✅ بله، ثبت پروژه حذف شود", `projdel:${p.id}`)
      .text("❌ انصراف", `projdetail:${p.id}`).row();
    this.navFooter(kb, true, true);

    let warn = "";
    if (activeSessions.length > 0) {
      warn = `\n\n❌ این پروژه دارای ${activeSessions.length} سشن فعال است. ابتدا سشن‌ها را متوقف یا حذف کنید.`;
    }

    const text =
      `⚠️ تأیید حذف ثبت پروژه "${p.name}" (#${p.id})\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `آیا از حذف این پروژه از فهرست TeleOps اطمینان دارید؟\n\n` +
      `🛡 توجه ایمنی: این عملیات فقط رکورد ثبت پروژه را از TeleOps پاک می‌کند و تمام فایل‌ها، پوشه‌ها و اطلاعات روی سرور کاملاً دست‌نخورده باقی می‌مانند.${warn}`;

    return { text, kb };
  }

  private logsMenuSpec(uid: number): { text: string; kb: InlineKeyboard } {
    const kb = new InlineKeyboard();
    kb.text("💻 لاگ‌های عمومی سیستم", "logsview:system")
      .text("🔴 لاگ خطاهای اخیر", "logsview:errors").row()
      .text("🔌 لاگ‌های SSH و سرور", "logsview:ssh")
      .text("🧩 رویدادهای سشن‌ها", "logsview:events").row()
      .text("🛡 لاگ‌های امنیتی", "logsview:security")
      .text("📋 لاگ‌های تسک‌ها", "logsview:tasks").row();
    this.navFooter(kb, true, true);
    return {
      text: "📜 گزارش‌ها، لاگ‌ها و عیب‌یابی سیستم TeleOps\n\nبرای مشاهده لاگ‌ها، بخش مورد نظر خود را انتخاب کنید:",
      kb,
    };
  }

  private async logsViewSpec(uid: number, type: string): Promise<{ text: string; kb: InlineKeyboard }> {
    const app = this.app;
    let title = "📜 لاگ‌ها";
    let body = "";

    switch (type) {
      case "system": {
        title = "💻 لاگ‌های عمومی سیستم";
        const modules = app.tracker.modules();
        body = modules.map((m) => `[${m}] وضعیت: ${app.tracker.state(m)} · خطاهای ۲۴ ساعت: ${app.tracker.count24h(m)}`).join("\n");
        break;
      }
      case "errors": {
        title = "🔴 لاگ خطاهای اخیر";
        const errs = app.tracker.recent(undefined, 15);
        body = errs.length
          ? errs.map((e) => `• [${e.module}] ${agoFa(e.at)}:\n  ${this.clip(e.message)}`).join("\n\n")
          : "✅ هیچ خطای اخیری ثبت نشده است.";
        break;
      }
      case "ssh": {
        title = "🔌 لاگ‌های SSH و ارتباط سرور";
        const conn = app.serverMode.connection;
        const hosts = app.db.listHosts();
        const lines: string[] = [];
        if (conn) {
          lines.push(`وضعیت اتصال جاری: ${conn.state}`);
          if (conn.lastErrorMessage) lines.push(`آخرین پیام: ${conn.lastErrorMessage}`);
        } else {
          lines.push("اتصال سراسری SSH فعال نیست.");
        }
        lines.push("\nوضعیت سرورها:");
        for (const h of hosts) {
          lines.push(`• #${h.id} ${h.name} (${h.host}): ${h.last_connected_at ? `اتصال در ${agoFa(h.last_connected_at)}` : "بررسی نشده"}${h.last_error ? ` (خطا: ${h.last_error})` : ""}`);
        }
        body = lines.join("\n");
        break;
      }
      case "events": {
        title = "🧩 رویدادهای اخیر سشن‌ها";
        const s = this.st(uid).activeSession;
        const events = s ? app.db.listEvents(s, 20) : [];
        body = events.length
          ? events.map((e) => `• ${agoFa(e.created_at)} [${e.type}] ${JSON.stringify(e.payload ?? {}).slice(0, 100)}`).join("\n")
          : (s ? "هیچ رویدادی برای سشن جاری ثبت نشده است." : "سشن فعالی انتخاب نشده است. از منوی سشن‌ها یک سشن را انتخاب کنید.");
        break;
      }
      case "security": {
        title = "🛡 لاگ‌های امنیتی و دسترسی";
        const admins = app.config.security.admin_users?.length ?? "همگانی";
        const allowed = app.config.security.allowed_users.length;
        const approvals = app.approvals.pending();
        body =
          `کاربران مجاز: ${allowed}\n` +
          `کاربران مدیر: ${admins}\n` +
          `تأییدیه‌های امنیتی در انتظار: ${approvals.length}\n` +
          (approvals.length ? approvals.map((a) => `• #${a.id} نوع: ${a.action_type} وضعیت: ${a.status}`).join("\n") : "✅ تأییدیه معلقی وجود ندارد.");
        break;
      }
      case "tasks": {
        title = "📋 لاگ‌های تسک‌ها";
        const logs = isAdminUser(app, uid) ? app.db.listTaskLogs({}, 10) : app.db.listTaskLogsForOwner(uid, 10);
        body = logs.length
          ? logs.map((t) => `• #${t.id} سشن #${t.session_id} [${t.status}] ${agoFa(t.started_at)}\n  مسیر: ${t.remote_path}`).join("\n\n")
          : "هنوز هیچ لاگ تسکی ثبت نشده است.";
        break;
      }
    }

    const kb = new InlineKeyboard();
    kb.text("↻ بروزرسانی", `logsview:${type}`).row();
    this.navFooter(kb, true, true);
    return {
      text: `${title}\n━━━━━━━━━━━━━━━━━━━━\n\n${this.clip(this.scrub(body))}`,
      kb,
    };
  }

  private settingsMenuSpec(uid: number): { text: string; kb: InlineKeyboard } {
    const kb = new InlineKeyboard();
    kb.text("👥 کاربران مجاز و دسترسی‌ها", "set:users")
      .text("⭐ تعیین سرور پیش‌فرض", "set:defhost").row()
      .text("📁 مسیرهای مجاز پروژه‌ها", "set:projroots")
      .text("🔑 کلید احراز هویت Qoder", "set:qoder").row()
      .text("🩺 وضعیت سلامت سرویس", "set:health")
      .text("🔄 همگام‌سازی وضعیت سیستم (Reconcile)", "set:reconcile").row()
      .text("ℹ️ اطلاعات نسخه و سیستم", "set:info").row();
    this.navFooter(kb, true, true);
    return {
      text: "⚙️ تنظیمات و پیکربندی سیستم TeleOps\n\nبخش مورد نظر را انتخاب کنید:",
      kb,
    };
  }

  private async settingsSubSpec(uid: number, type: string): Promise<{ text: string; kb: InlineKeyboard }> {
    const app = this.app;
    const kb = new InlineKeyboard();
    let text = "";

    switch (type) {
      case "users": {
        const allowed = app.config.security.allowed_users;
        const admins = app.config.security.admin_users ?? allowed;
        text =
          `👥 مدیریت کاربران و سطوح دسترسی\n━━━━━━━━━━━━━━━━━━━━\n` +
          `• تعداد کل کاربران مجاز: ${allowed.length}\n` +
          `• کاربران مجاز: ${allowed.join(", ")}\n` +
          `• مدیران سامانه (Admin Users): ${admins.join(", ")}\n` +
          `• شناسه شما: ${uid} (${isAdminUser(app, uid) ? "مدیر کل ⭐" : "کاربر استاندارد"})\n\n` +
          `💡 نکته: جهت تغییر کاربران مجاز، فایل پیکربندی config.yaml را ویرایش کنید.`;
        break;
      }
      case "defhost": {
        const hosts = isAdminUser(app, uid) ? app.db.listHosts() : app.db.listHostsForOwner(uid);
        const active = this.hostIdForUser(uid);
        text = `⭐ تعیین سرور پیش‌فرض / فعال\n━━━━━━━━━━━━━━━━━━━━\nسرور پیش‌فرض برای اجرای دستورات و سشن‌های جدید را انتخاب کنید:\n\n`;
        for (const h of hosts) {
          const isAct = h.id === active;
          kb.text(`${isAct ? "⭐" : "▫️"} ${h.name}`, `setdefhost:${h.id}`).row();
          text += `• #${h.id} ${h.name} (${h.username}@${h.host}:${h.port}) ${isAct ? "← فعال" : ""}\n`;
        }
        if (!hosts.length) text += "هیچ سروری ثبت نشده است.";
        break;
      }
      case "projroots": {
        const ps = isAdminUser(app, uid) ? app.db.listProjects() : app.db.listProjectsForOwner(uid);
        text =
          `📁 مسیرهای مجاز و ثبت‌شده پروژه‌ها\n━━━━━━━━━━━━━━━━━━━━\n` +
          `تعداد پروژه‌ها: ${ps.length}\n\n` +
          ps.map((p) => `• #${p.id} ${p.name}: ${p.root} [${p.host_id ? `سرور #${p.host_id}` : "لوکال"}]`).join("\n");
        break;
      }
      case "qoder": {
        return this.qoderKeySpec(uid);
      }
      case "health": {
        text = this.healthText();
        break;
      }
      case "reconcile": {
        const rec = await app.sessions.reconcile().catch((e: unknown) => ({ error: (e as Error).message }));
        text =
          `🔄 نتیجه همگام‌سازی وضعیت سیستم (Reconcile)\n━━━━━━━━━━━━━━━━━━━━\n` +
          `سشن‌ها و پردازه‌های tmux با موفقیت با دیتابیس هماهنگ شدند.\n` +
          `اطلاعات وضعیت جاری:\n${JSON.stringify(rec, null, 2)}`;
        break;
      }
      case "info": {
        const mem = process.memoryUsage();
        text =
          `ℹ️ مشخصات و وضعیت نسخه TeleOps\n━━━━━━━━━━━━━━━━━━━━\n` +
          `• نام سیستم: TeleOps AI Command Center\n` +
          `• پلتفرم: ${process.platform} (${process.arch})\n` +
          `• نسخه Node.js: ${process.version}\n` +
          `• زمان بالا بودن (Uptime): ${Math.round(process.uptime())} ثانیه\n` +
          `• شناسه پردازه (PID): ${process.pid}\n` +
          `• مصرف حافظه: ${Math.round(mem.rss / 1024 / 1024)} MB\n` +
          `• ترنسپورت سشن‌ها: ${app.sessions.remoteMode ? "Remote SSH" : "Local Direct"}\n` +
          `• آداپترهای فعال: ${app.adapters.ids().join(", ")}`;
        break;
      }
    }

    this.navFooter(kb, true, true);
    return { text, kb };
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

    if (state.pendingRename) {
      if (text.startsWith("/")) return;
      const { type, id } = state.pendingRename;
      state.pendingRename = undefined;
      const cleanName = text.trim();
      if (!cleanName) {
        await ctx.reply("❌ نام نمی‌تواند خالی باشد.");
        return;
      }
      if (type === "server") {
        app.db.updateHost(id, { name: cleanName });
        await this.navigate(ctx, ctx.from!.id, `hostdetail:${id}`);
      } else if (type === "project") {
        app.db.updateProject(id, { name: cleanName });
        await this.navigate(ctx, ctx.from!.id, `projdetail:${id}`);
      } else if (type === "session") {
        app.db.updateSession(id, { name: cleanName });
        await this.enterChat(ctx, id);
      }
      return;
    }

    if (state.pendingInput) {
      if (text.startsWith("/")) return;
      const { sessionId } = state.pendingInput;
      state.pendingInput = undefined;
      const s = resolveSession(app, ctx.from!.id, sessionId);
      if (!s) return this.deny(ctx);
      try {
        await app.sessions.sendInput(sessionId, text);
        await this.enterChat(ctx, sessionId);
      } catch (e) {
        await this.fail(ctx, e);
      }
      return;
    }

    if (state.sessionWizard?.step === "name" || state.sessionWizard?.step === "task") {
      if (text.startsWith("/")) return;
      const sw = state.sessionWizard;
      state.sessionWizard = undefined;
      await this.finishSessionWizard(ctx, sw, text.trim());
      return;
    }

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
      if (text === "/cancel") {
        state.projectWizard = undefined;
        await ctx.reply("لغو شد.");
        return;
      }
      if (text.startsWith("/") && !text.slice(1).includes("/")) {
        await ctx.reply("📁 یک مسیر معتبر روی سرور (مثلاً: /srv/app) را ارسال کنید، یا /cancel را بفرستید:");
        return;
      }
      const hostId = typeof state.projectWizard === "object" && state.projectWizard.hostId
        ? state.projectWizard.hostId
        : this.hostIdForUser(ctx.from!.id);
      if (hostId === null) {
        await ctx.reply("🔌 هیچ سروری متصل نیست. ابتدا با دستور /addserver سرور خود را متصل کنید.");
        return;
      }
      const registered = await this.registerProject(ctx, hostId, text.trim());
      if (registered) {
        state.projectWizard = undefined;
        const p = app.db.listRemoteProjects(hostId).find((x) => x.root.replace(/\/+$/, "") === text.trim().replace(/\/+$/, ""));
        if (p) await this.navigate(ctx, ctx.from!.id, `projdetail:${p.id}`);
      }
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
    await ctx.reply("سشن را از منوی سشن‌ها باز کنید / Open a session via /sessions first to send it messages, or use /send <id> <message>.");
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
      this.st(ctx.from!.id).serverWizard = { step: "name", draft: {} };
      return ctx.reply(
        "🖥 افزودن سرور (۱ از ۵)\n\nیک نام نمایشی دلخواه برای این سرور وارد کنید:\nبرای انصراف /cancel را بفرستید.",
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
  private hostsSpec(uid: number): { text: string; kb: InlineKeyboard } {
    const hosts = isAdminUser(this.app, uid)
      ? this.app.db.listHosts()
      : this.app.db.listHostsForOwner(uid);
    const kb = new InlineKeyboard();
    kb.text("➕ افزودن سرور جدید", "nav:addserver").row();
    if (!hosts.length) {
      this.navFooter(kb, true, true);
      return {
        text: "🖥 سرورهای من (SSH Hosts)\n\nهیچ سروری برای شما ثبت نشده است.\nاز دکمه «➕ افزودن سرور جدید» استفاده کنید.",
        kb,
      };
    }
    const active = this.hostIdForUser(uid);
    const lines = hosts.map((h) => {
      const isDef = h.id === active;
      const marker = isDef ? "⭐" : "▫️";
      const mine = h.owner_telegram_user_id === uid ? "شخصی" : h.owner_telegram_user_id == null ? "عمومی" : `کاربر ${h.owner_telegram_user_id}`;
      const status = h.last_connected_at ? `✅ ${agoFa(h.last_connected_at)}` : "⚪ بررسی‌نشده";
      kb.text(`${marker} ${h.name} (${h.username}@${h.host})`, `hostdetail:${h.id}`).row();
      return `${marker} #${h.id} ${h.name}\n   └ ${h.username}@${h.host}:${h.port} (${mine}) · وضعیت: ${status}`;
    });
    this.navFooter(kb, true, true);
    return {
      text: "🖥 سرورهای من (SSH Hosts)\n\n" + lines.join("\n\n") + "\n\n⭐ = سرور فعال شما\nبرای مشاهده مشخصات، تست اتصال یا تغییرات، روی سرور مورد نظر بزنید:",
      kb,
    };
  }

  private async hostsOverview(ctx: Context): Promise<void> {
    await this.navigate(ctx, ctx.from!.id, "hosts");
  }

  private async handleHostUse(ctx: Context, hostId: number): Promise<void> {
    const uid = ctx.from!.id;
    const host = resolveHost(this.app, uid, hostId);
    if (!host) return this.deny(ctx);
    this.app.hosts.activateHostForUser(uid, hostId);
    let note = `🖥 سرور فعال به "${host.name}" تغییر یافت.`;
    const globalActive = this.app.db.getActiveHost();
    if (globalActive?.id === hostId) {
      try {
        await this.app.serverMode.switchActiveHost(hostId);
        note += "\nترنسپورت سراسری به این سرور متصل شد.";
      } catch (e) {
        this.app.tracker.report("ssh", e, { step: "switch_host", host: host.name });
        note += `\n⚠️ خطای تغییر اتصال زنده: ${(e as Error).message}`;
      }
    }
    await this.navigate(ctx, uid, `hostdetail:${hostId}`);
  }

  private async handleHostDelete(ctx: Context, hostId: number): Promise<void> {
    const uid = ctx.from!.id;
    const host = resolveHost(this.app, uid, hostId);
    if (!host) return this.deny(ctx);
    if (!isAdminUser(this.app, uid) && (host.owner_telegram_user_id !== uid || host.visibility === "shared"))
      return this.deny(ctx);
    const projects = this.app.db.listRemoteProjects(hostId);
    const allSessions = isAdminUser(this.app, uid) ? this.app.db.listSessions() : this.app.db.listSessionsForOwner(uid);
    if (projects.some((p) => allSessions.some((s) => s.project_id === p.id && ACTIVE_STATUSES.includes(s.status)))) {
      await ctx.reply("❌ این سرور دارای سشن‌های فعال است — ابتدا آن‌ها را متوقف کنید.");
      return;
    }
    this.app.db.deleteHost(hostId);
    this.app.db.raw().prepare("DELETE FROM user_active_hosts WHERE telegram_user_id = ? AND host_id = ?").run(uid, hostId);
    if (isAdminUser(this.app, uid) && !this.app.db.getActiveHost()) {
      try {
        await this.app.serverMode.switchActiveHost(null);
      } catch {}
    }
    await this.navigate(ctx, uid, "hosts");
  }

  private async handleHostTest(ctx: Context, hostId: number): Promise<void> {
    const uid = ctx.from!.id;
    const host = resolveHost(this.app, uid, hostId);
    if (!host) return this.deny(ctx);
    const testResult = await this.app.hosts.testHost(hostId);
    const statusText = testResult.ok
      ? `✅ اتصال SSH با موفقیت برقرار شد!\nمیزبان: ${testResult.hostname ?? host.host}\nکاربر: ${testResult.user ?? host.username}\n${testResult.tmux ? `نسخه tmux: ${testResult.tmux}` : "⚠️ برنامه tmux نصب نیست"}`
      : `❌ خطا در برقراری ارتباط با سرور:\n${testResult.error ?? "خطای نامشخص"}`;
    const kb = new InlineKeyboard()
      .text("⚡ آزمایش مجدد", `hosttest:${hostId}`).row()
      .text("⬅️ بازگشت به مشخصات سرور", `hostdetail:${hostId}`);
    this.navFooter(kb, true, true);
    await this.screen(
      ctx,
      `hosttest:${hostId}`,
      `⚡ نتیجه آزمایش اتصال سرور "${host.name}":\n━━━━━━━━━━━━━━━━━━━━\n\n${statusText}`,
      kb,
    );
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

    if (w.step === "name") {
      w.draft.name = value;
      w.step = "host";
      await ctx.reply("🖥 افزودن سرور (۲ از ۵)\n\nآدرس سرور (IP یا Hostname) را ارسال کنید:\nبرای انصراف /cancel را بفرستید.");
      return;
    }

    if (w.step === "host") {
      if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
        await ctx.reply("❌ آدرس وارد شده معتبر نیست. لطفاً مجدداً آدرس یا IP را ارسال کنید (یا /cancel):");
        return;
      }
      w.draft.host = value;
      if (!w.draft.name) w.draft.name = value;
      w.step = "port";
      await ctx.reply(`🖥 افزودن سرور (۳ از ۵)\n\nپورت SSH برای ${value} را وارد کنید (یک عدد بین ۱ تا ۶۵۵۳۵، یا "default" برای ۲۲):`);
      return;
    }

    if (w.step === "port") {
      const port = value === "default" || value === "22" ? 22 : Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        await ctx.reply('❌ پورت باید عددی بین ۱ تا ۶۵۵۳۵ باشد (یا "default"):');
        return;
      }
      w.draft.port = port;
      w.step = "user";
      await ctx.reply("🖥 افزودن سرور (۴ از ۵)\n\nنام کاربری SSH سرور (مثلاً root یا ubuntu) را ارسال کنید:");
      return;
    }

    if (w.step === "user") {
      if (!/^[A-Za-z0-9._-]+$/.test(value)) {
        await ctx.reply("❌ نام کاربری نامعتبر است. مجدداً تلاش کنید یا /cancel را بفرستید:");
        return;
      }
      w.draft.username = value;
      w.step = "auth_type";
      const kb = new InlineKeyboard()
        .text("🔑 کلید اختصاصی SSH (Key)", "srvwizard:auth:key")
        .text("🔒 رمز عبور (Password)", "srvwizard:auth:password");
      await ctx.reply("🖥 افزودن سرور (۵ از ۵)\n\nشیوه احراز هویت را انتخاب کنید:", { reply_markup: kb });
      return;
    }

    if (w.step === "auth_type") {
      w.draft.auth_type = value.toLowerCase().includes("key") ? "key" : "password";
      w.step = "credential";
      await ctx.reply(
        w.draft.auth_type === "key"
          ? "🔑 متن کلید خصوصی SSH (Private Key) را بفرستید (پیام پس از ذخیره بلافاصله پاک خواهد شد):"
          : "🔒 رمز عبور SSH را ارسال کنید (پیام پس از ذخیره بلافاصله پاک خواهد شد):",
      );
      return;
    }

    // step "credential" or "pass"
    if (!value) {
      await ctx.reply("❌ مقدار ارسال شده خالی است. مجدداً ارسال کنید یا /cancel را بفرستید.");
      return;
    }
    const { host, port, username, name, auth_type } = w.draft;
    const finalAuth = auth_type ?? "password";
    const chatId = ctx.chat?.id;
    const userMsgId = ctx.msg?.message_id;

    // Delete password / private key message immediately
    if (chatId && userMsgId) {
      try {
        await this.bot.api.deleteMessage(chatId, userMsgId);
      } catch {
        app.logs.system.warn("could not delete credential message");
      }
    }

    const testing = await ctx.reply(`⏳ در حال آزمایش اتصال واقعی SSH به ${username}@${host}:${port}…`);
    const testCreds = finalAuth === "key"
      ? { host: host!, port: port!, username: username!, privateKey: value }
      : { host: host!, port: port!, username: username!, password: value };

    const result = await app.hosts.testConnection(testCreds);
    try {
      if (chatId) await this.bot.api.deleteMessage(chatId, testing.message_id);
    } catch {}

    if (!result.ok) {
      await ctx.reply(
        `❌ اتصال به سرور ناموفق بود!\nخطای دریافتی:\n${result.error ?? "خطای نامشخص"}\n\n` +
          "لطفاً اطلاعات احراز هویت صحیح را ارسال کنید یا برای انصراف /cancel را بفرستید.",
      );
      return;
    }

    let saved;
    try {
      saved = app.hosts.addHost({
        name: name || host!,
        host: host!,
        port: port!,
        username: username!,
        auth_type: finalAuth,
        password: finalAuth === "password" ? value : undefined,
        private_key: finalAuth === "key" ? value : undefined,
        activate: true,
        owner: uid,
      });
    } catch (e) {
      app.tracker.report("config", e, { step: "save_host" });
      await ctx.reply(`❌ اتصال موفق بود اما ذخیره سرور ناموفق بود: ${(e as Error).message}`);
      return;
    }
    state.serverWizard = undefined;

    const globalActive = app.db.getActiveHost();
    if (globalActive?.id === saved.id) {
      try {
        await app.serverMode.switchActiveHost(saved.id);
      } catch (e) {
        app.tracker.report("ssh", e, { step: "switch_host", host: saved.name });
        await ctx.reply(
          `⚠️ سرور ذخیره شد اما جابه‌جایی زنده ترنسپورت با خطا مواجه شد: ${(e as Error).message}\n` +
            "با دستور /hosts وضعیت را بررسی کنید.",
        );
        return;
      }
      await ctx.reply(
        `✅ سرور "${saved.name}" با موفقیت متصل و ذخیره شد!\n` +
          `ترنسپورت فعال سیستم به SSH متصل شد.\n` +
          (result.tmux ? `نسخه tmux: ${result.tmux}\n` : `⚠️ برنامه tmux روی سرور یافت نشد — پیش از ایجاد سشن آن را نصب کنید.\n`) +
          `\nاکنون می‌توانید با دکمه «📁 پروژه‌ها» مسیر پروژه خود را ثبت کنید.`,
      );
      await this.navigate(ctx, uid, `hostdetail:${saved.id}`);
      return;
    }
    await ctx.reply(
      `✅ سرور "${saved.name}" (#${saved.id}) با موفقیت ذخیره و به‌عنوان سرور فعال شما تعیین شد.`,
    );
    await this.navigate(ctx, uid, `hostdetail:${saved.id}`);
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

  private async handleProjectDelete(ctx: Context, projId: number): Promise<void> {
    const uid = ctx.from!.id;
    const p = resolveProject(this.app, uid, projId);
    if (!p) return this.deny(ctx);
    if (!canManageProject(this.app, uid, p)) return this.deny(ctx);
    const allSessions = isAdminUser(this.app, uid) ? this.app.db.listSessions() : this.app.db.listSessionsForOwner(uid);
    if (allSessions.some((s) => s.project_id === projId && ACTIVE_STATUSES.includes(s.status))) {
      await ctx.reply(`❌ پروژه #${projId} دارای سشن فعال است — ابتدا سشن‌ها را متوقف یا حذف کنید.`);
      return;
    }
    this.app.db.deleteProject(projId);
    await this.navigate(ctx, uid, "projects");
  }

  private async handleProjectCheck(ctx: Context, projId: number): Promise<void> {
    const uid = ctx.from!.id;
    const p = resolveProject(this.app, uid, projId);
    if (!p) return this.deny(ctx);
    let pathOk = false;
    let gitOk = false;
    let details = "";
    if (p.host_id) {
      const exists = await this.app.serverMode.execOnHost(p.host_id, "test", ["-d", p.root]);
      pathOk = exists.code === 0;
      if (pathOk) {
        const repoCheck = await this.app.serverMode.execOnHost(
          p.host_id,
          "git",
          ["-C", p.root, "rev-parse", "--is-inside-work-tree"],
        );
        gitOk = repoCheck.code === 0 && repoCheck.stdout.trim() === "true";
      } else {
        details = exists.stderr ? ` (${exists.stderr.slice(0, 100)})` : "";
      }
    } else {
      pathOk = fs.existsSync(p.root);
      gitOk = await this.app.git.isRepo(p.root).catch(() => false);
    }
    const kb = new InlineKeyboard();
    kb.text("🧩 سشن جدید", `sessnew:prj:${p.host_id ?? 0}:${p.id}`)
      .text("⬅️ بازگشت به پروژه", `projdetail:${p.id}`);
    this.navFooter(kb, true, true);
    await this.screen(
      ctx,
      `projcheck:${projId}`,
      `🔍 نتیجه بررسی مسیر و گیت پروژه "${p.name}":\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `• مسیر روی سرور: ${p.root}\n` +
      `• وجود دایرکتوری: ${pathOk ? "✅ موجود و قابل دسترس" : `❌ یافت نشد${details}`}\n` +
      `• وضعیت Git: ${gitOk ? "✅ مخزن گیت معتبر" : "⚠️ مخزن گیت نیست"}`,
      kb,
    );
  }

  private async finishSessionWizard(
    ctx: Context,
    sw: SessionCreationWizard,
    nameOrTask: string,
  ): Promise<void> {
    const uid = ctx.from!.id;
    const app = this.app;
    const project = sw.projectId ? resolveProject(app, uid, sw.projectId) : undefined;
    const agent = sw.agent ?? "shell";
    const cwd = project?.root ?? process.cwd();
    const sessionName = nameOrTask ? `${agent} - ${nameOrTask.slice(0, 30)}` : `${agent} - ${project?.name ?? "adhoc"}`;

    if (
      this.app.adapters.get(agent)?.credentialEnvVar &&
      !this.app.credentials.hasCredential(uid)
    ) {
      await ctx.reply(
        CREDENTIAL_REQUIRED_MESSAGE +
          "\n\nRun /qoderkey, tap “Set token” and reply with your token.",
      );
      return;
    }

    try {
      const created = await app.sessions.create({
        name: sessionName,
        project_id: project?.id ?? null,
        agent,
        cwd,
        owner_telegram_user_id: uid,
      });
      await app.sessions.start(created.id, nameOrTask || undefined);
      this.st(uid).activeSession = created.id;
      const branch = await app.git.currentBranch(cwd);
      if (branch) app.db.updateSession(created.id, { branch });
      await this.enterChat(ctx, created.id);
    } catch (e) {
      await this.fail(ctx, e);
    }
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
      await this.screen(ctx, "logs", await this.taskLogText(latest), this.logButtons(latest));
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
    kb.text("📟 Live screen", `act:logs:${sessionId}`).row().text("⬅ Back", "back");
    const current = logs[0]!;
    await this.screen(
      ctx,
      `logs:${sessionId}`,
      `📜 LOGS — session #${sessionId} (${logs.length} files)\n\nShowing the newest:\n\n` +
        (await this.taskLogText(current)),
      kb,
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
    // start() now really spawns + verifies the process (seconds of latency);
    // a repeated/double-sent task message while that is in flight must NOT
    // create a second session or re-emit the lifecycle events.
    if (w.busy) {
      await ctx.reply("⏳ That task is already launching — one moment.");
      return;
    }
    this.st(uid).wizard = { ...w, busy: true };
    const release = () => {
      const cur = this.st(uid).wizard;
      if (cur) this.st(uid).wizard = { ...cur, busy: false };
    };
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
      release();
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
      const now = this.app.db.getSession(created.id);
      await ctx.reply(
        `✅ Session #${created.id} created\nAgent: ${w.agent}\nProject: ${
          project?.name ?? "(adhoc)"
        }\nStatus: ${now?.status ?? "working"}\nChatting now — send messages to talk to the agent.`,
        { reply_markup: this.sessionKb(created.id) },
      );
    } catch (e) {
      release();
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
  private qoderKeySpec(uid: number): { text: string; kb: InlineKeyboard } {
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
    kb.text("⬅ Back", "back");
    return { text: lines.join("\n"), kb };
  }

  private async qoderKeyCommand(ctx: Context): Promise<void> {
    await this.navigate(ctx, ctx.from!.id, "qoderkey");
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
    // Navigation NEVER stacks new messages: every screen below is rendered by
    // EDITING the single recorded dashboard message (screen()); ⬅ Back pops the
    // per-user stack. Every branch acknowledges the callback.
    if (data === "menu:main") {
      await this.navigate(ctx, uid, "main");
      return ack();
    }

    if (data === "back") {
      await this.goBack(ctx, uid);
      return ack();
    }

    if (data.startsWith("nav:")) {
      const key = parts[1] ?? "";
      const DASHBOARD = new Set([
        "main",
        "sessions",
        "hosts",
        "projects",
        "server",
        "processes",
        "health",
        "alerts",
        "settings",
        "qoderkey",
        "logs",
      ]);
      if (DASHBOARD.has(key)) {
        await this.navigate(ctx, uid, key);
        return ack();
      }
      switch (key) {
        case "git":
          await ctx.reply("Open 🌿 Git from a session, or use /git <session id>.");
          break;
        case "new":
          await this.startWizard(ctx);
          break;
        case "addserver": {
          this.st(uid).serverWizard = { step: "name", draft: {} };
          await ctx.reply(
            "🖥 افزودن سرور (۱ از ۵)\n\nیک نام نمایشی دلخواه برای این سرور وارد کنید:\nبرای انصراف /cancel را بفرستید.",
          );
          break;
        }
        case "addproject": {
          const hostId = await this.requireRemote(ctx);
          if (hostId !== null) {
            this.st(uid).projectWizard = { hostId };
            await ctx.reply("📁 یک مسیر معتبر روی سرور (مثلاً: /srv/app) را ارسال کنید:\nبرای انصراف /cancel را بفرستید.");
          }
          break;
        }
      }
      return ack();
    }

    if (data.startsWith("srvwizard:auth:")) {
      const authType = parts[2] === "key" ? "key" : "password";
      const state = this.st(uid);
      if (state.serverWizard) {
        state.serverWizard.draft.auth_type = authType;
        state.serverWizard.step = "credential";
        await ctx.reply(
          authType === "key"
            ? "🔑 متن کلید خصوصی SSH (Private Key) را بفرستید (پیام پس از ذخیره بلافاصله پاک خواهد شد):"
            : "🔒 رمز عبور SSH را ارسال کنید (پیام پس از ذخیره بلافاصله پاک خواهد شد):",
        );
      }
      return ack();
    }

    if (data.startsWith("hostdetail:")) {
      await this.navigate(ctx, uid, `hostdetail:${parts[1]}`);
      return ack();
    }

    if (data.startsWith("hosttest:")) {
      await this.handleHostTest(ctx, Number(parts[1]));
      return ack();
    }

    if (data.startsWith("hostdelreq:")) {
      await this.navigate(ctx, uid, `hostdelreq:${parts[1]}`);
      return ack();
    }

    if (data.startsWith("hostrename:")) {
      const hid = Number(parts[1]);
      if (!resolveHost(app, uid, hid)) {
        await this.deny(ctx);
        return ack();
      }
      this.st(uid).pendingRename = { type: "server", id: hid };
      await ctx.reply("✏️ نام جدید سرور را ارسال کنید:\nبرای انصراف /cancel را بفرستید.");
      return ack();
    }

    if (data.startsWith("hostprojs:")) {
      await this.navigate(ctx, uid, "projects");
      return ack();
    }

    if (data.startsWith("hostsess:")) {
      await this.navigate(ctx, uid, "sessions");
      return ack();
    }

    if (data.startsWith("projdetail:")) {
      await this.navigate(ctx, uid, `projdetail:${parts[1]}`);
      return ack();
    }

    if (data.startsWith("projcheck:")) {
      await this.handleProjectCheck(ctx, Number(parts[1]));
      return ack();
    }

    if (data.startsWith("projdef:")) {
      const pid = Number(parts[1]);
      const p = resolveProject(app, uid, pid);
      if (!p) {
        await this.deny(ctx);
        return ack();
      }
      this.app.db.setUserDefaultProject?.(uid, pid);
      await this.navigate(ctx, uid, `projdetail:${pid}`);
      return ack();
    }

    if (data.startsWith("projrename:")) {
      const pid = Number(parts[1]);
      const p = resolveProject(app, uid, pid);
      if (!p) {
        await this.deny(ctx);
        return ack();
      }
      this.st(uid).pendingRename = { type: "project", id: pid };
      await ctx.reply("✏️ نام جدید پروژه را ارسال کنید:\nبرای انصراف /cancel را بفرستید.");
      return ack();
    }

    if (data.startsWith("projdelreq:")) {
      await this.navigate(ctx, uid, `projdelreq:${parts[1]}`);
      return ack();
    }

    if (data.startsWith("projdel:")) {
      await this.handleProjectDelete(ctx, Number(parts[1]));
      return ack();
    }

    if (data === "projnew:start") {
      const hostId = this.hostIdForUser(uid);
      if (hostId === null) {
        await ctx.reply("🔌 ابتدا از بخش «سرورها» یک سرور ثبت یا انتخاب کنید.");
        return ack();
      }
      this.st(uid).projectWizard = { hostId };
      await ctx.reply("📁 یک مسیر معتبر روی سرور (مثلاً: /srv/app) را ارسال کنید:\nبرای انصراف /cancel را بفرستید.");
      return ack();
    }

    if (data === "sessnew:start") {
      const hostId = this.hostIdForUser(uid);
      const projects = hostId
        ? this.app.db.listRemoteProjects(hostId).filter((p) => projectVisibleTo(app, uid, p))
        : (isAdminUser(app, uid) ? this.app.db.listProjects() : this.app.db.listProjectsForOwner(uid));
      if (!projects.length) {
        await ctx.reply("📁 هیچ پروژه‌ای ثبت نشده است. ابتدا از بخش «پروژه‌ها» یک پروژه ثبت کنید.");
        return ack();
      }
      const kb = new InlineKeyboard();
      for (const p of projects) {
        kb.text(p.name, `sessnew:prj:${p.host_id ?? 0}:${p.id}`).row();
      }
      this.navFooter(kb, true, true);
      await this.screen(ctx, "sessnew:pickproj", "➕ ایجاد سشن جدید — گام ۱: انتخاب پروژه:\n\nپروژه مورد نظر را انتخاب کنید:", kb);
      return ack();
    }

    if (data.startsWith("sessnew:prj:")) {
      const projId = Number(parts[3] ?? parts[2]);
      const p = resolveProject(app, uid, projId);
      if (!p) {
        await this.deny(ctx);
        return ack();
      }
      const kb = new InlineKeyboard();
      kb.text("💻 ترمینال شل لینوکس (Shell / Bash)", `sessnew:mode:${projId}:shell`).row();
      for (const a of app.adapters.ids()) {
        if (a !== "shell") kb.text(`🤖 ایجنت هوش مصنوعی ${a}`, `sessnew:mode:${projId}:${a}`).row();
      }
      this.navFooter(kb, true, true);
      await this.screen(ctx, `sessnew:pickagent:${projId}`, `➕ ایجاد سشن برای پروژه "${p.name}" — گام ۲: نوع سشن:\n\nحالت اجرای سشن را انتخاب کنید:`, kb);
      return ack();
    }

    if (data.startsWith("sessnew:mode:")) {
      const projId = Number(parts[2]);
      const agent = parts[3];
      const p = resolveProject(app, uid, projId);
      if (!p) {
        await this.deny(ctx);
        return ack();
      }
      if (agent === "shell") {
        await this.finishSessionWizard(ctx, { step: "name", projectId: projId, agent: "shell" }, "");
      } else {
        this.st(uid).sessionWizard = { step: "task", projectId: projId, agent };
        await ctx.reply(`🤖 تسک یا دستور اولیه برای ایجنت ${agent} را ارسال کنید:\nبرای انصراف /cancel را بفرستید.`);
      }
      return ack();
    }

    if (data.startsWith("sessrefresh:")) {
      await this.enterChat(ctx, Number(parts[1]));
      return ack();
    }

    if (data.startsWith("sessin:")) {
      const sid = Number(parts[1]);
      if (!resolveSession(app, uid, sid)) {
        await this.deny(ctx);
        return ack();
      }
      this.st(uid).pendingInput = { sessionId: sid };
      await ctx.reply(`⌨️ ورودی یا پیام خود برای سشن #${sid} را بفرستید:\nبرای انصراف /cancel را بفرستید.`);
      return ack();
    }

    if (data.startsWith("sessctrlc:")) {
      const sid = Number(parts[1]);
      if (!resolveSession(app, uid, sid)) {
        await this.deny(ctx);
        return ack();
      }
      try {
        await app.sessions.sendKey(sid, "C-c");
        await ctx.reply(`🛑 کلید Ctrl+C به سشن #${sid} ارسال شد.`);
        await this.enterChat(ctx, sid);
      } catch (e) {
        await this.fail(ctx, e);
      }
      return ack();
    }

    if (data.startsWith("sessstopreq:")) {
      const sid = Number(parts[1]);
      if (!resolveSession(app, uid, sid)) {
        await this.deny(ctx);
        return ack();
      }
      await this.safe(() => app.sessions.stop(sid), ctx, `⏹ سشن #${sid} متوقف شد.`);
      await this.enterChat(ctx, sid);
      return ack();
    }

    if (data.startsWith("sessresume:")) {
      const sid = Number(parts[1]);
      if (!resolveSession(app, uid, sid)) {
        await this.deny(ctx);
        return ack();
      }
      await this.safe(() => app.sessions.resume(sid), ctx, `▶ سشن #${sid} ادامه یافت.`);
      await this.enterChat(ctx, sid);
      return ack();
    }

    if (data.startsWith("sessrename:")) {
      const sid = Number(parts[1]);
      if (!resolveSession(app, uid, sid)) {
        await this.deny(ctx);
        return ack();
      }
      this.st(uid).pendingRename = { type: "session", id: sid };
      await ctx.reply(`✏️ نام جدید سشن #${sid} را ارسال کنید:\nبرای انصراف /cancel را بفرستید.`);
      return ack();
    }

    if (data.startsWith("logsview:")) {
      await this.navigate(ctx, uid, `logsview:${parts[1]}`);
      return ack();
    }

    if (data.startsWith("set:")) {
      await this.navigate(ctx, uid, `set:${parts[1]}`);
      return ack();
    }

    if (data.startsWith("setdefhost:")) {
      const hid = Number(parts[1]);
      if (!resolveHost(app, uid, hid)) {
        await this.deny(ctx);
        return ack();
      }
      this.app.hosts.activateHostForUser(uid, hid);
      await this.navigate(ctx, uid, "set:defhost");
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

    if (data.startsWith("hist50:")) {
      const id = Number(parts[1]);
      // the id is a selector only — ownership is re-resolved server-side
      if (!resolveSession(app, uid, id)) {
        await this.deny(ctx);
        return ack();
      }
      const lines = storedHistoryLines(app.db.listEvents(id, 500), 50).map(
        (l) => `[${l.source.toUpperCase()}] ${this.scrub(l.text)}`,
      );
      await ctx.reply(
        lines.length
          ? this.clip(lines.join("\n")) || "(stored output is empty)"
          : "No stored output for this session yet.",
      );
      return ack();
    }

    if (data.startsWith("delreq:")) {
      const id = Number(parts[1]);
      const s = resolveSession(app, uid, id);
      if (!s) {
        await this.deny(ctx);
        return ack();
      }
      await ctx.reply(
        `⚠️ Delete session #${id} (${this.scrub(s.name)})?\nThis stops the agent, ` +
          `closes the shell and removes ALL stored history. Cannot be undone.`,
        {
          reply_markup: new InlineKeyboard()
            .text("✅ Yes, delete", `del:${id}`)
            .text("⬅ Cancel", `sess:${id}`),
        },
      );
      return ack();
    }

    if (data.startsWith("del:")) {
      const id = Number(parts[1]);
      const s = resolveSession(app, uid, id);
      if (!s) {
        await this.deny(ctx);
        return ack();
      }
      // ONE delete path shared with the Mini App: stop agent, remove row +
      // stored history, kill shell pane + live ring via SessionManager hooks
      await app.sessions.remove(id);
      if (this.st(uid).activeSession === id) this.st(uid).activeSession = undefined;
      await ctx.reply(`🗑 Session #${id} deleted together with its history.`);
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
      if (parts.length === 2) {
        await this.gitView(ctx, Number(parts[1]));
        return ack();
      }
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

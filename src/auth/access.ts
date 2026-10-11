import { DB } from "../db/database";
import type { Config } from "../config/config";
import { Approval, Project, SessionRecord, SshHost, TaskLog } from "../shared/types";

/**
 * Central authorization layer. EVERY data path (Telegram commands, callbacks,
 * plain text, notifications) must resolve resources through this module —
 * hiding buttons in the UI is not an access control. Callback data and command
 * arguments are treated as untrusted: a resource id is only ever acted on
 * after `isAdminUser` / ownership checks here.
 */

/** Single generic refusal — never leaks whether the resource exists. */
export const DENY_MESSAGE = "⛔ You do not have access to this resource.";

export interface AccessContext {
  db: DB;
  config: Config;
}

export function isAllowedUser(app: { config: Config }, userId: number | undefined): boolean {
  if (userId == null) return false;
  return app.config.security.allowed_users.includes(userId);
}

/**
 * A user is admin when listed in `security.admin_users`. Legacy configs without
 * `admin_users` keep the old behaviour: every allowed user has full access.
 * Set `admin_users` explicitly to get real per-user isolation.
 */
export function isAdminUser(app: { config: Config }, userId: number | undefined): boolean {
  if (!isAllowedUser(app, userId)) return false;
  const admins = app.config.security.admin_users;
  if (admins === undefined) return true;
  return admins.includes(userId as number);
}

export function adminUserIds(app: { config: Config }): number[] {
  const sec = app.config.security;
  return sec.admin_users ?? sec.allowed_users;
}

// ---------- resource resolvers ----------
// Each returns the record when the user may access it, or null otherwise.
// NULL owner (legacy rows) is ADMIN-ONLY — normal users never gain access to
// unowned data by guessing ids.

export function sessionVisibleTo(app: AccessContext, userId: number, s: SessionRecord): boolean {
  if (isAdminUser(app, userId)) return true;
  return s.owner_telegram_user_id === userId;
}

export function resolveSession(app: AccessContext, userId: number, sessionId: number): SessionRecord | null {
  const s = app.db.getSession(sessionId);
  if (!s || !sessionVisibleTo(app, userId, s)) return null;
  return s;
}

export function accessibleSessions(app: AccessContext, userId: number): SessionRecord[] {
  return app.db.listSessions().filter((s) => sessionVisibleTo(app, userId, s));
}

export function projectVisibleTo(app: AccessContext, userId: number, p: Project): boolean {
  if (isAdminUser(app, userId)) return true;
  // normal users: own projects, plus explicitly shared ones.
  return p.owner_telegram_user_id === userId || p.visibility === "shared";
}

export function resolveProject(app: AccessContext, userId: number, projectId: number): Project | null {
  const p = app.db.getProject(projectId);
  if (!p || !projectVisibleTo(app, userId, p)) return null;
  return p;
}

/** Manage = edit/delete/register-under. Shared projects stay admin-managed. */
export function canManageProject(app: AccessContext, userId: number, p: Project): boolean {
  if (isAdminUser(app, userId)) return true;
  return p.visibility === "private" && p.owner_telegram_user_id === userId;
}

export function accessibleProjects(app: AccessContext, userId: number): Project[] {
  return app.db.listProjects().filter((p) => projectVisibleTo(app, userId, p));
}

export function hostVisibleTo(app: AccessContext, userId: number, h: SshHost): boolean {
  if (isAdminUser(app, userId)) return true;
  return h.owner_telegram_user_id === userId || h.visibility === "shared";
}

export function resolveHost(app: AccessContext, userId: number, hostId: number): SshHost | null {
  const h = app.db.getHost(hostId);
  if (!h || !hostVisibleTo(app, userId, h)) return null;
  return h;
}

export function canManageHost(app: AccessContext, userId: number, h: SshHost): boolean {
  if (isAdminUser(app, userId)) return true;
  return h.visibility === "private" && h.owner_telegram_user_id === userId;
}

export function accessibleHosts(app: AccessContext, userId: number): SshHost[] {
  return app.db.listHosts().filter((h) => hostVisibleTo(app, userId, h));
}

export function resolveTaskLog(app: AccessContext, userId: number, logId: number): TaskLog | null {
  const t = app.db.getTaskLog(logId);
  if (!t) return null;
  const s = app.db.getSession(t.session_id);
  if (!s || !sessionVisibleTo(app, userId, s)) return null;
  return t;
}

export function resolveApproval(app: AccessContext, userId: number, approvalId: number): Approval | null {
  const a = app.db.getApproval(approvalId);
  if (!a) return null;
  if (a.session_id == null) return isAdminUser(app, userId) ? a : null;
  const s = app.db.getSession(a.session_id);
  if (!s || !sessionVisibleTo(app, userId, s)) return null;
  return a;
}

/**
 * The host a user's remote operations target: their per-user active host if
 * set (and still accessible), else the global active host when they're admin
 * or when it is owned by them.
 */
export function effectiveActiveHostId(app: AccessContext, userId: number): number | null {
  const own = app.db.getUserActiveHostId(userId);
  if (own != null && resolveHost(app, userId, own)) return own;
  const global = app.db.getActiveHost();
  if (!global) return null;
  if (isAdminUser(app, userId) || global.owner_telegram_user_id === userId) return global.id;
  return null;
}

// ---------- secrets ----------
const SECRET_LINE_RE =
  /(password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key)\s*[:=]\s*\S+/gi;

/** Strip obvious secret assignments before echoing agent output to chat. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_LINE_RE, "$1: ***");
}

import { AccessContext, adminUserIds } from "../auth/access";
import type { DomainEvent } from "../shared/types";

/**
 * Notification/live-output destination resolution. There is NO global
 * "primary chat" anymore: every session-scoped message goes to the chat
 * recorded for the session's OWNER, so one user's activity can never redirect
 * another user's output.
 */

export function adminChatIds(app: AccessContext): number[] {
  const out = new Set<number>();
  for (const uid of adminUserIds(app)) {
    const chat = app.db.getUserChat(uid);
    if (chat != null) out.add(chat);
  }
  return [...out];
}

/** Chats that should receive a session-scoped (or global) notification. */
export function notificationChatIds(app: AccessContext, event: DomainEvent): number[] {
  if (event.session_id == null) return adminChatIds(app);
  const s = app.db.getSession(event.session_id);
  if (!s) return [];
  const ids = new Set<number>();
  const ownerChat =
    s.owner_telegram_user_id != null ? app.db.getUserChat(s.owner_telegram_user_id) : null;
  if (ownerChat != null) ids.add(ownerChat);
  // legacy unowned sessions and opted-in admins additionally get a copy
  if (s.owner_telegram_user_id == null || app.config.security.admin_receive_all_notifications)
    for (const c of adminChatIds(app)) ids.add(c);
  return [...ids];
}

/**
 * Where live output for a session goes: the owner's chat. Returns null when
 * the owner never interacted with the bot (nowhere to send) — it never falls
 * back to "whoever was active last".
 */
export function liveOutputTarget(
  app: AccessContext,
  sessionId: number,
): { userId: number; chatId: number } | null {
  const s = app.db.getSession(sessionId);
  if (!s) return null;
  if (s.owner_telegram_user_id != null) {
    const chatId = app.db.getUserChat(s.owner_telegram_user_id);
    return chatId != null ? { userId: s.owner_telegram_user_id, chatId } : null;
  }
  // legacy session (admin-only) → first admin chat, deterministically
  for (const uid of [...adminUserIds(app)].sort((a, b) => a - b)) {
    const chatId = app.db.getUserChat(uid);
    if (chatId != null) return { userId: uid, chatId };
  }
  return null;
}

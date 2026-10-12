import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations";
import {
  Approval,
  ApprovalStatus,
  CredentialStatus,
  DomainEvent,
  MessageDirection,
  Project,
  ResourceVisibility,
  SessionMessage,
  SessionRecord,
  SessionStatus,
  SshHost,
  TaskLog,
} from "../shared/types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  root TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  agent_type TEXT NOT NULL,
  cwd TEXT NOT NULL,
  terminal_id TEXT,
  pid INTEGER,
  status TEXT NOT NULL,
  branch TEXT,
  waiting_reason TEXT,
  last_output TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  type TEXT NOT NULL,
  payload TEXT,
  severity TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  action_type TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
`;

export class DB {
  private db: Database.Database;

  constructor(databaseFile: string) {
    fs.mkdirSync(path.dirname(path.resolve(databaseFile)), { recursive: true });
    this.db = new Database(databaseFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    runMigrations(this.db);
  }

  schemaVersion(): number {
    return this.db.pragma("user_version", { simple: true }) as number;
  }

  /** Escape hatch for tooling (cli.ts) only — application code should use the DAOs. */
  raw(): Database.Database {
    return this.db;
  }

  // ---- projects ----
  createProject(
    name: string,
    root: string,
    host_id?: number | null,
    owner_telegram_user_id?: number | null,
    visibility: ResourceVisibility = "private",
  ): Project {
    const info = this.db
      .prepare(
        "INSERT INTO projects (name, root, host_id, owner_telegram_user_id, visibility) VALUES (?, ?, ?, ?, ?)",
      )
      .run(name, root, host_id ?? null, owner_telegram_user_id ?? null, visibility);
    return this.getProject(Number(info.lastInsertRowid))!;
  }
  getProject(id: number): Project | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | Project
      | undefined;
  }
  /** Admin view: everything. Normal users must use listProjectsForOwner. */
  listProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY id").all() as Project[];
  }
  /** Owner-scoped query: rows owned by the user plus explicitly shared ones. */
  listProjectsForOwner(ownerTelegramUserId: number): Project[] {
    return this.db
      .prepare(
        `SELECT * FROM projects
         WHERE owner_telegram_user_id = ? OR visibility = 'shared'
         ORDER BY id`,
      )
      .all(ownerTelegramUserId) as Project[];
  }
  listRemoteProjects(hostId: number): Project[] {
    return this.db
      .prepare("SELECT * FROM projects WHERE host_id = ? ORDER BY id")
      .all(hostId) as Project[];
  }
  deleteProject(id: number): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
  setProjectOwner(id: number, ownerTelegramUserId: number): void {
    this.db
      .prepare("UPDATE projects SET owner_telegram_user_id = ? WHERE id = ?")
      .run(ownerTelegramUserId, id);
  }

  // ---- ssh hosts ----
  createHost(h: {
    name: string;
    host: string;
    port: number;
    username: string;
    password_enc: string;
    owner_telegram_user_id?: number | null;
    visibility?: ResourceVisibility;
  }): SshHost {
    const info = this.db
      .prepare(
        `INSERT INTO ssh_hosts (name, host, port, username, password_enc, owner_telegram_user_id, visibility)
         VALUES (@name, @host, @port, @username, @password_enc, @owner_telegram_user_id, @visibility)`,
      )
      .run({
        owner_telegram_user_id: null,
        visibility: "private" as ResourceVisibility,
        ...h,
      });
    return this.getHost(Number(info.lastInsertRowid))!;
  }
  getHost(id: number): SshHost | undefined {
    return this.db.prepare("SELECT * FROM ssh_hosts WHERE id = ?").get(id) as
      | SshHost
      | undefined;
  }
  updateHost(
    id: number,
    patch: Partial<Pick<SshHost, "host" | "port" | "username" | "password_enc" | "name">>,
  ): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db
      .prepare(
        `UPDATE ssh_hosts SET ${sets}, updated_at = datetime('now') WHERE id = @id`,
      )
      .run({ ...patch, id });
  }
  listHosts(): SshHost[] {
    return this.db.prepare("SELECT * FROM ssh_hosts ORDER BY id").all() as SshHost[];
  }
  /** Owner-scoped query: the user's own hosts plus explicitly shared ones. */
  listHostsForOwner(ownerTelegramUserId: number): SshHost[] {
    return this.db
      .prepare(
        `SELECT * FROM ssh_hosts
         WHERE owner_telegram_user_id = ? OR visibility = 'shared'
         ORDER BY id`,
      )
      .all(ownerTelegramUserId) as SshHost[];
  }
  getActiveHost(): SshHost | undefined {
    return this.db
      .prepare("SELECT * FROM ssh_hosts WHERE is_active = 1 LIMIT 1")
      .get() as SshHost | undefined;
  }
  setActiveHost(id: number): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE ssh_hosts SET is_active = 0").run();
      this.db
        .prepare(
          "UPDATE ssh_hosts SET is_active = 1, updated_at = datetime('now') WHERE id = ?",
        )
        .run(id);
    })();
  }
  deleteHost(id: number): void {
    this.db.prepare("DELETE FROM ssh_hosts WHERE id = ?").run(id);
  }

  // ---- per-user host choice + chat routing ----
  getUserActiveHostId(telegramUserId: number): number | null {
    const row = this.db
      .prepare("SELECT host_id FROM user_active_hosts WHERE telegram_user_id = ?")
      .get(telegramUserId) as { host_id: number } | undefined;
    return row?.host_id ?? null;
  }
  setUserActiveHost(telegramUserId: number, hostId: number): void {
    this.db
      .prepare(
        `INSERT INTO user_active_hosts (telegram_user_id, host_id, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(telegram_user_id) DO UPDATE SET host_id = excluded.host_id, updated_at = excluded.updated_at`,
      )
      .run(telegramUserId, hostId);
  }
  clearUserActiveHost(telegramUserId: number): void {
    this.db
      .prepare("DELETE FROM user_active_hosts WHERE telegram_user_id = ?")
      .run(telegramUserId);
  }
  getUserChat(telegramUserId: number): number | null {
    const row = this.db
      .prepare("SELECT chat_id FROM user_chats WHERE telegram_user_id = ?")
      .get(telegramUserId) as { chat_id: number } | undefined;
    return row?.chat_id ?? null;
  }
  /** Record/refresh the chat to deliver this user's notifications into. */
  upsertUserChat(telegramUserId: number, chatId: number): void {
    this.db
      .prepare(
        `INSERT INTO user_chats (telegram_user_id, chat_id, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id = excluded.chat_id, updated_at = excluded.updated_at`,
      )
      .run(telegramUserId, chatId);
  }

  // ---- per-user qoder credentials ----
  /** key_enc is AES-256-GCM at rest; UI layers must use listCredentialStatuses. */
  getQoderCredential(telegramUserId: number): { key_enc: string; status: string } | undefined {
    return this.db
      .prepare(
        "SELECT key_enc, status FROM qoder_credentials WHERE telegram_user_id = ?",
      )
      .get(telegramUserId) as { key_enc: string; status: string } | undefined;
  }
  upsertQoderCredential(telegramUserId: number, keyEnc: string): void {
    this.db
      .prepare(
        `INSERT INTO qoder_credentials (telegram_user_id, key_enc, status, updated_at)
         VALUES (?, ?, 'configured', datetime('now'))
         ON CONFLICT(telegram_user_id)
         DO UPDATE SET key_enc = excluded.key_enc, status = 'configured', updated_at = excluded.updated_at`,
      )
      .run(telegramUserId, keyEnc);
  }
  setCredentialStatus(telegramUserId: number, status: CredentialStatus): void {
    this.db
      .prepare(
        "UPDATE qoder_credentials SET status = ?, updated_at = datetime('now') WHERE telegram_user_id = ?",
      )
      .run(status, telegramUserId);
  }
  deleteQoderCredential(telegramUserId: number): void {
    this.db
      .prepare("DELETE FROM qoder_credentials WHERE telegram_user_id = ?")
      .run(telegramUserId);
  }
  /** Statuses ONLY — never the encrypted value. For admin visibility. */
  listCredentialStatuses(): Array<{
    telegram_user_id: number;
    status: CredentialStatus;
    updated_at: string;
  }> {
    return this.db
      .prepare(
        "SELECT telegram_user_id, status, updated_at FROM qoder_credentials ORDER BY telegram_user_id",
      )
      .all() as Array<{
      telegram_user_id: number;
      status: CredentialStatus;
      updated_at: string;
    }>;
  }

  /** Internal scrubbing support — encrypted blobs only, never returned to UI. */
  listCredentialKeyBlobs(): Array<{ telegram_user_id: number; key_enc: string }> {
    return this.db
      .prepare("SELECT telegram_user_id, key_enc FROM qoder_credentials")
      .all() as Array<{ telegram_user_id: number; key_enc: string }>;
  }

  // ---- task logs ----
  createTaskLog(t: {
    session_id: number;
    project_id: number | null;
    remote_path: string;
    task: string | null;
    status: string;
  }): TaskLog {
    const info = this.db
      .prepare(
        `INSERT INTO task_logs (session_id, project_id, remote_path, task, status)
         VALUES (@session_id, @project_id, @remote_path, @task, @status)`,
      )
      .run(t);
    return this.getTaskLog(Number(info.lastInsertRowid))!;
  }
  getTaskLog(id: number): TaskLog | undefined {
    return this.db.prepare("SELECT * FROM task_logs WHERE id = ?").get(id) as
      | TaskLog
      | undefined;
  }
  closeTaskLog(id: number, status: string, size_bytes?: number | null): void {
    this.db
      .prepare(
        `UPDATE task_logs SET status = ?, ended_at = datetime('now'), size_bytes = COALESCE(?, size_bytes)
         WHERE id = ?`,
      )
      .run(status, size_bytes ?? null, id);
  }
  listTaskLogs(filter: { session_id?: number; project_id?: number }, limit = 20): TaskLog[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit };
    if (filter.session_id !== undefined) {
      where.push("session_id = @session_id");
      params.session_id = filter.session_id;
    }
    if (filter.project_id !== undefined) {
      where.push("project_id = @project_id");
      params.project_id = filter.project_id;
    }
    const sql =
      `SELECT * FROM task_logs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}` +
      " ORDER BY id DESC LIMIT @limit";
    return this.db.prepare(sql).all(params) as TaskLog[];
  }
  /** Owner-scoped query: task logs of the user's own sessions only. */
  listTaskLogsForOwner(ownerTelegramUserId: number, limit = 20): TaskLog[] {
    return this.db
      .prepare(
        `SELECT t.* FROM task_logs t
         JOIN sessions s ON s.id = t.session_id
         WHERE s.owner_telegram_user_id = ?
         ORDER BY t.id DESC LIMIT ?`,
      )
      .all(ownerTelegramUserId, limit) as TaskLog[];
  }

  // ---- sessions ----
  createSession(s: {
    name: string;
    project_id: number | null;
    agent_type: string;
    cwd: string;
    owner_telegram_user_id?: number | null;
  }): SessionRecord {
    const info = this.db
      .prepare(
        `INSERT INTO sessions (name, project_id, agent_type, cwd, status, owner_telegram_user_id)
         VALUES (@name, @project_id, @agent_type, @cwd, 'CREATED', @owner_telegram_user_id)`,
      )
      .run({ owner_telegram_user_id: null, ...s });
    return this.getSession(Number(info.lastInsertRowid))!;
  }
  getSession(id: number): SessionRecord | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRecord
      | undefined;
  }
  /** Admin view: every session, including legacy unowned rows. */
  listSessions(): SessionRecord[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY id DESC")
      .all() as SessionRecord[];
  }
  /** Owner-scoped query for normal users — legacy NULL-owner rows never appear. */
  listSessionsForOwner(ownerTelegramUserId: number): SessionRecord[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE owner_telegram_user_id = ? ORDER BY id DESC")
      .all(ownerTelegramUserId) as SessionRecord[];
  }
  setSessionOwner(id: number, ownerTelegramUserId: number): void {
    this.db
      .prepare("UPDATE sessions SET owner_telegram_user_id = ? WHERE id = ?")
      .run(ownerTelegramUserId, id);
  }
  /**
   * Hard-remove a session and its stored history. task_logs has a real FK to
   * sessions (foreign_keys=ON) and the other tables have no cascade, so all
   * child rows are deleted first in one transaction.
   */
  deleteSession(id: number): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM task_logs WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM session_events WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM approvals WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    });
    tx();
  }
  updateSession(
    id: number,
    patch: Partial<
      Pick<
        SessionRecord,
        | "status"
        | "terminal_id"
        | "pid"
        | "branch"
        | "waiting_reason"
        | "last_output"
        | "log_path"
        | "name"
      >
    >,
  ): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db
      .prepare(
        `UPDATE sessions SET ${sets}, updated_at = datetime('now') WHERE id = @id`,
      )
      .run({ ...patch, id });
  }
  setStatus(id: number, status: SessionStatus): void {
    this.updateSession(id, { status });
  }

  // ---- events ----
  addEvent(e: {
    session_id?: number;
    type: string;
    payload?: unknown;
    severity?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO session_events (session_id, type, payload, severity)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        e.session_id ?? null,
        e.type,
        e.payload === undefined ? null : JSON.stringify(e.payload),
        e.severity ?? null,
      );
  }
  listEvents(sessionId: number, limit = 50): DomainEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Array<{
      session_id: number;
      type: string;
      payload: string | null;
      severity: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      session_id: r.session_id,
      type: r.type as DomainEvent["type"],
      severity: r.severity as DomainEvent["severity"],
      created_at: r.created_at,
      payload: r.payload ? JSON.parse(r.payload) : undefined,
    }));
  }

  // ---- messages ----
  addMessage(m: {
    session_id: number;
    direction: MessageDirection;
    content: string;
    source?: string;
  }): SessionMessage {
    const info = this.db
      .prepare(
        `INSERT INTO session_messages (session_id, direction, content, source)
         VALUES (?, ?, ?, ?)`,
      )
      .run(m.session_id, m.direction, m.content, m.source ?? null);
    return this.db
      .prepare("SELECT * FROM session_messages WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as SessionMessage;
  }
  listMessages(sessionId: number, limit = 50): SessionMessage[] {
    return this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM session_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(sessionId, limit) as SessionMessage[];
  }

  // ---- approvals ----
  createApproval(a: {
    session_id: number | null;
    action_type: string;
    payload?: unknown;
    telegram_message_id?: number;
  }): Approval {
    const info = this.db
      .prepare(
        `INSERT INTO approvals (session_id, action_type, payload, telegram_message_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        a.session_id ?? null,
        a.action_type,
        a.payload === undefined ? null : JSON.stringify(a.payload),
        a.telegram_message_id ?? null,
      );
    return this.getApproval(Number(info.lastInsertRowid))!;
  }
  getApproval(id: number): Approval | undefined {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(id) as
      | (Omit<Approval, "payload"> & { payload: string | null })
      | undefined;
    if (!row) return undefined;
    return { ...row, payload: row.payload ? JSON.parse(row.payload) : {} };
  }
  resolveApproval(id: number, status: ApprovalStatus): void {
    this.db
      .prepare(
        `UPDATE approvals SET status = ?, resolved_at = datetime('now') WHERE id = ?`,
      )
      .run(status, id);
  }
  listPendingApprovals(): Approval[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE status = 'PENDING' ORDER BY id")
      .all() as Array<Omit<Approval, "payload"> & { payload: string | null }>;
    return rows.map((r) => ({
      ...r,
      payload: r.payload ? JSON.parse(r.payload) : {},
    }));
  }

  close(): void {
    this.db.close();
  }
}

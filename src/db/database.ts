import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations";
import {
  Approval,
  ApprovalStatus,
  DomainEvent,
  MessageDirection,
  Project,
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
  createProject(name: string, root: string, host_id?: number | null): Project {
    const info = this.db
      .prepare("INSERT INTO projects (name, root, host_id) VALUES (?, ?, ?)")
      .run(name, root, host_id ?? null);
    return this.getProject(Number(info.lastInsertRowid))!;
  }
  getProject(id: number): Project | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | Project
      | undefined;
  }
  listProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY id").all() as Project[];
  }
  listRemoteProjects(hostId: number): Project[] {
    return this.db
      .prepare("SELECT * FROM projects WHERE host_id = ? ORDER BY id")
      .all(hostId) as Project[];
  }
  deleteProject(id: number): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  // ---- ssh hosts ----
  createHost(h: {
    name: string;
    host: string;
    port: number;
    username: string;
    password_enc: string;
  }): SshHost {
    const info = this.db
      .prepare(
        `INSERT INTO ssh_hosts (name, host, port, username, password_enc)
         VALUES (@name, @host, @port, @username, @password_enc)`,
      )
      .run(h);
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

  // ---- sessions ----
  createSession(s: {
    name: string;
    project_id: number | null;
    agent_type: string;
    cwd: string;
  }): SessionRecord {
    const info = this.db
      .prepare(
        `INSERT INTO sessions (name, project_id, agent_type, cwd, status)
         VALUES (@name, @project_id, @agent_type, @cwd, 'CREATED')`,
      )
      .run(s);
    return this.getSession(Number(info.lastInsertRowid))!;
  }
  getSession(id: number): SessionRecord | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRecord
      | undefined;
  }
  listSessions(): SessionRecord[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY id DESC")
      .all() as SessionRecord[];
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { DB } from "../src/db/database";
import { runMigrations } from "../src/db/migrations";
import { tempDbFile, tempDir } from "./helpers";
import fs from "node:fs";
import path from "node:path";

/**
 * Builds a database at v4 (the pre-multi-user schema) with real rows,
 * exactly like an installation that has been running before this feature.
 */
function buildLegacyDb(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  root TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  host_id INTEGER REFERENCES ssh_hosts(id)
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  log_path TEXT
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
CREATE TABLE IF NOT EXISTS ssh_hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  project_id INTEGER REFERENCES projects(id),
  remote_path TEXT NOT NULL,
  task TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  size_bytes INTEGER
);
INSERT INTO ssh_hosts (id, name, host, port, username, password_enc, is_active)
  VALUES (1, 'oldhost', '10.0.0.1', 22, 'root', 'enc-blob', 1);
INSERT INTO projects (id, name, root, host_id) VALUES (1, 'oldproj', '/srv/old', 1);
INSERT INTO sessions (id, name, project_id, agent_type, cwd, status)
  VALUES (1, 'legacy session', 1, 'qoder', '/srv/old', 'STOPPED');
INSERT INTO session_messages (session_id, direction, content) VALUES (1, 'USER_TO_AGENT', 'old task');
INSERT INTO task_logs (session_id, project_id, remote_path, status) VALUES (1, 1, '/srv/old/.teleops/logs/x.log', 'FINISHED');
`);
  db.pragma("user_version = 4");
  db.close();
}

describe("ownership migration", () => {
  it("upgrades a legacy DB without losing data", () => {
    const file = tempDbFile(tempDir("teleops-mig-"));
    buildLegacyDb(file);

    const db = new DB(file);
    assert.ok(db.schemaVersion() >= 6);
    // v6 tables arrive on the upgraded legacy DB (per-user credentials + grants)
    const tables = db
      .raw()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    assert.ok(tables.some((t) => t.name === "qoder_credentials"));
    assert.ok(tables.some((t) => t.name === "credential_grants"));

    // original rows survived
    const s = db.getSession(1);
    assert.ok(s);
    assert.equal(s!.name, "legacy session");
    assert.equal(s!.owner_telegram_user_id, null); // safe default: admin-only
    assert.equal(db.getProject(1)!.name, "oldproj");
    assert.equal(db.getProject(1)!.visibility, "private");
    assert.equal(db.getHost(1)!.host, "10.0.0.1");
    assert.equal(db.listMessages(1, 10)[0]!.content, "old task");
    assert.equal(db.listTaskLogs({}, 10).length, 1);

    db.close();
  });

  it("legacy rows are invisible to owner-scoped queries but visible to admin queries", () => {
    const file = tempDbFile(tempDir("teleops-mig-"));
    buildLegacyDb(file);
    const db = new DB(file);

    assert.equal(db.listSessionsForOwner(111).length, 0); // normal user sees nothing of the legacy data
    assert.equal(db.listSessions().length, 1); // admin view keeps it
    assert.equal(db.listProjectsForOwner(111).length, 0);
    assert.equal(db.listHostsForOwner(111).length, 0);
    db.close();
  });

  it("migration is idempotent — reopening the upgraded DB applies nothing new", () => {
    const file = tempDbFile(tempDir("teleops-mig-"));
    buildLegacyDb(file);
    const db1 = new DB(file);
    const v1 = db1.schemaVersion();
    db1.close();
    const raw = new Database(file);
    const appliedAgain = runMigrations(raw);
    assert.equal(appliedAgain, v1);
    raw.close();
    const db2 = new DB(file);
    assert.equal(db2.getSession(1)?.name, "legacy session");
    db2.close();
  });

  it("fresh DB lands on the latest version with owner columns present", () => {
    const db = new DB(tempDbFile(tempDir("teleops-fresh-")));
    assert.ok(db.schemaVersion() >= 5);
    const s = db.createSession({ name: "x", project_id: null, agent_type: "shell", cwd: "/tmp", owner_telegram_user_id: 42 });
    assert.equal(s.owner_telegram_user_id, 42);
    db.upsertUserChat(42, 777);
    assert.equal(db.getUserChat(42), 777);
    db.close();
  });
});

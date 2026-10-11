import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

/**
 * Ordered, versioned migrations driven by PRAGMA user_version.
 * v1 is the base SCHEMA in database.ts (idempotent CREATE IF NOT EXISTS).
 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: "base-schema", up: () => {} },
  {
    version: 2,
    name: "ssh_hosts",
    up: (db) => {
      db.exec(`
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
CREATE INDEX IF NOT EXISTS idx_hosts_active ON ssh_hosts(is_active);
`);
    },
  },
  {
    version: 3,
    name: "projects.host_id",
    up: (db) => {
      addColumn(db, "projects", "host_id", "INTEGER REFERENCES ssh_hosts(id)");
    },
  },
  {
    version: 4,
    name: "task_logs + sessions.log_path",
    up: (db) => {
      addColumn(db, "sessions", "log_path", "TEXT");
      db.exec(`
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
CREATE INDEX IF NOT EXISTS idx_task_logs_session ON task_logs(session_id, id);
CREATE INDEX IF NOT EXISTS idx_task_logs_project ON task_logs(project_id, id);
`);
    },
  },
];

function addColumn(
  db: Database.Database,
  table: string,
  column: string,
  decl: string,
): void {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function runMigrations(db: Database.Database): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  let applied = current;
  for (const m of MIGRATIONS.filter((x) => x.version > current)) {
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
    applied = m.version;
  }
  return applied;
}

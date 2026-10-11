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
  {
    version: 5,
    name: "multi-user ownership",
    up: (db) => {
      // Legacy rows keep owner_telegram_user_id = NULL, which the access layer
      // treats as ADMIN-ONLY — normal users never gain access to pre-existing
      // data. Nothing is deleted or reassigned automatically: the first admin
      // to run /claim <resource> <id> (or the admin UI) takes ownership.
      addColumn(db, "sessions", "owner_telegram_user_id", "INTEGER");
      addColumn(db, "projects", "owner_telegram_user_id", "INTEGER");
      addColumn(db, "projects", "visibility", "TEXT NOT NULL DEFAULT 'private'");
      addColumn(db, "ssh_hosts", "owner_telegram_user_id", "INTEGER");
      addColumn(db, "ssh_hosts", "visibility", "TEXT NOT NULL DEFAULT 'private'");
      db.exec(`
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_telegram_user_id, id);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_hosts_owner ON ssh_hosts(owner_telegram_user_id);

-- Last chat seen for each allowed user, used to route session notifications
-- and live output to the OWNER of the session (replaces the global
-- primaryChatId). Written only from authorized interactions.
CREATE TABLE IF NOT EXISTS user_chats (
  telegram_user_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-user "active server" pointer so one user's host switch cannot affect
-- another user's view. The globally connected SSH transport remains a
-- separate, admin-controlled concept (server-mode hot-swap).
CREATE TABLE IF NOT EXISTS user_active_hosts (
  telegram_user_id INTEGER PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES ssh_hosts(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
    },
  },
  {
    version: 6,
    name: "per-user qoder credentials",
    up: (db) => {
      // Credentials are keyed by TELEGRAM USER, never by session: all of one
      // user's sessions use their own credential. key_enc is AES-256-GCM
      // (SecretBox) — the plaintext never touches the DB, config, argv, logs
      // or Telegram. status ∈ {configured, invalid}; "missing" = no row.
      // Provisioning grants store only a sha256 hash of a short-lived
      // single-use token; the key itself is never accepted in chat.
      db.exec(`
CREATE TABLE IF NOT EXISTS qoder_credentials (
  telegram_user_id INTEGER PRIMARY KEY,
  key_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'configured',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS credential_grants (
  token_hash TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credential_grants_user ON credential_grants(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_credential_grants_expiry ON credential_grants(expires_at);
`);
    },
  },
  {
    version: 7,
    name: "drop credential provisioning grants",
    up: (db) => {
      // Mini App / one-time-link provisioning was removed — the token now
      // enters through the /qoderkey chat flow, so grant rows are dead weight.
      db.exec(`
DROP INDEX IF EXISTS idx_credential_grants_user;
DROP INDEX IF EXISTS idx_credential_grants_expiry;
DROP TABLE IF EXISTS credential_grants;
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

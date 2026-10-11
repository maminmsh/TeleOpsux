import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import "dotenv/config";

export interface AgentsConfig {
  [agent: string]: { enabled: boolean; command: string };
}

export interface SecurityConfig {
  /** Telegram user ids allowed to use the bot at all (normal users + admins). */
  allowed_users: number[];
  /**
   * Telegram user ids with full operator access (sees/manages ALL resources).
   * When undefined (legacy config), every allowed user is treated as admin so
   * existing single-operator setups keep working — set admin_users to enable
   * real per-user isolation.
   */
  admin_users?: number[];
  /** Also deliver every session notification to admins, not only the owner. */
  admin_receive_all_notifications?: boolean;
  project_roots: string[];
}

export interface Config {
  telegram: { enabled: boolean; botToken: string };
  sessions: {
    max_concurrent: number;
    heartbeat_interval_seconds: number;
    idle_no_output_seconds: number;
    reconnect: boolean;
    tmux_prefix: string;
  };
  security: SecurityConfig;
  agents: AgentsConfig;
  monitor: {
    interval_seconds: number;
    cpu_warning: number;
    cpu_critical: number;
    ram_warning: number;
    ram_critical: number;
    disk_warning: number;
    disk_critical: number;
    load_enabled: boolean;
  };
  policy: { allowed: string[]; approval_required: string[] };
  notifications: { rules: Record<string, string> };
  ssh: {
    exec_timeout_seconds: number;
    ready_timeout_seconds: number;
    keepalive_seconds: number;
  };
  credentials: {
    /** Ask Qoder whether the token works BEFORE storing it. */
    validate_pat: boolean;
    pat_validation_timeout_seconds: number;
  };
  paths: {
    database_file: string;
    session_root: string;
    log_root: string;
    secret_key_file: string;
  };
}

const DEFAULTS: Config = {
  telegram: { enabled: true, botToken: "" },
  sessions: {
    max_concurrent: 8,
    heartbeat_interval_seconds: 5,
    idle_no_output_seconds: 90,
    reconnect: true,
    tmux_prefix: "teleops",
  },
  security: { allowed_users: [], project_roots: [] },
  agents: {
    qoder: { enabled: true, command: "qoder" },
    codex: { enabled: false, command: "codex" },
    shell: { enabled: true, command: "bash" },
  },
  monitor: {
    interval_seconds: 30,
    cpu_warning: 80,
    cpu_critical: 95,
    ram_warning: 80,
    ram_critical: 90,
    disk_warning: 80,
    disk_critical: 90,
    load_enabled: true,
  },
  policy: {
    allowed: ["git status", "git diff", "git log", "git branch"],
    approval_required: ["git push", "git commit", "rm", "sudo", "systemctl restart"],
  },
  notifications: {
    rules: {
      APPROVAL_REQUIRED: "telegram_notify",
      USER_INPUT_REQUIRED: "telegram_notify",
      COMMAND_FAILED: "telegram_notify",
      PROCESS_CRASHED: "telegram_notify",
      SESSION_FINISHED: "telegram_notify",
      CREDENTIAL_INVALID: "telegram_notify",
    },
  },
  ssh: {
    exec_timeout_seconds: 20,
    ready_timeout_seconds: 15,
    keepalive_seconds: 15,
  },
  credentials: {
    validate_pat: true,
    pat_validation_timeout_seconds: 25,
  },
  paths: {
    database_file: "./data/teleops.db",
    session_root: "./data/sessions",
    log_root: "./logs",
    secret_key_file: "./data/teleops.key",
  },
};

function deepMerge<T>(base: T, override: unknown): T {
  if (
    typeof base === "object" &&
    base !== null &&
    !Array.isArray(base) &&
    typeof override === "object" &&
    override !== null
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      out[k] = k in (base as Record<string, unknown>)
        ? deepMerge((base as Record<string, unknown>)[k] as unknown, v)
        : v;
    }
    return out as T;
  }
  return (override === undefined ? base : (override as T));
}

export function loadConfig(configFile?: string): Config {
  const file =
    configFile ??
    process.env.CONFIG_FILE ??
    path.join(process.cwd(), "config", "config.yaml");

  let fileConfig: unknown = {};
  if (fs.existsSync(file)) {
    fileConfig = yaml.load(fs.readFileSync(file, "utf8")) ?? {};
  }

  const merged = deepMerge(DEFAULTS, fileConfig);

  merged.telegram.botToken =
    process.env.TELEGRAM_BOT_TOKEN ?? merged.telegram.botToken ?? "";
  merged.paths.database_file =
    process.env.DATABASE_FILE ?? merged.paths.database_file;
  merged.paths.session_root =
    process.env.SESSION_ROOT ?? merged.paths.session_root;
  merged.paths.log_root = process.env.LOG_ROOT ?? merged.paths.log_root;
  merged.paths.secret_key_file =
    process.env.TELEOPS_SECRET_KEY_FILE ?? merged.paths.secret_key_file;

  return merged;
}

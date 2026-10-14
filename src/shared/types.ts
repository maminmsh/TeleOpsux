// Shared domain types and enums for the AI Command Center core.
// These are intentionally independent of Telegram so the core stays UI-agnostic.

export type SessionStatus =
  | "CREATED"
  | "STARTING"
  | "WORKING"
  | "WAITING_INPUT"
  | "WAITING_APPROVAL"
  | "ERROR"
  | "STOPPING"
  | "STOPPED"
  | "FINISHED"
  | "CRASHED";

export type AgentType = "qoder" | "codex" | "shell" | string;

export type MessageDirection = "USER_TO_AGENT" | "AGENT_TO_USER" | "SYSTEM";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

export type Severity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export type EventType =
  | "SESSION_CREATED"
  | "SESSION_STARTED"
  | "SESSION_RECONNECTED"
  | "SESSION_OUTPUT"
  | "AGENT_WORKING"
  | "AGENT_WAITING"
  | "APPROVAL_REQUIRED"
  | "USER_INPUT_REQUIRED"
  | "COMMAND_STARTED"
  | "COMMAND_FAILED"
  | "COMMAND_FINISHED"
  | "TEST_FAILED"
  | "BUILD_FAILED"
  | "GIT_CHANGED"
  | "COMMIT_CREATED"
  | "PROCESS_CRASHED"
  | "SESSION_STOPPED"
  | "SESSION_FINISHED"
  | "SERVER_LOW_MEMORY"
  | "SERVER_HIGH_DISK_USAGE"
  | "SERVER_HIGH_CPU"
  | "MODULE_ERROR"
  | "CREDENTIAL_INVALID"
  | "SSH_CONNECTED"
  | "SSH_DISCONNECTED";

export interface DomainEvent {
  type: EventType;
  session_id?: number;
  payload?: Record<string, unknown>;
  severity?: Severity;
  created_at: string;
}

export type ResourceVisibility = "private" | "shared";

/**
 * Per-user credential state. "missing" is represented by the ABSENCE of a row.
 * The secret value itself is never part of any status/UI surface.
 */
export type CredentialStatus = "configured" | "invalid";

export interface Project {
  id: number;
  name: string;
  root: string;
  /** NULL = legacy local root; set = path on that ssh host. */
  host_id: number | null;
  /** Owning Telegram user; NULL = legacy row, admin-only. */
  owner_telegram_user_id: number | null;
  /** "shared" resources are usable by all allowed users; only admins may manage them. */
  visibility: ResourceVisibility;
  description?: string | null;
  created_at: string;
}

export interface SshHost {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  /** AES-256-GCM encrypted password, base64 (iv:tag:ciphertext). Never sent to logs/Telegram. */
  password_enc: string;
  auth_type?: "password" | "key";
  private_key_enc?: string | null;
  last_connected_at?: string | null;
  last_error?: string | null;
  is_active: number;
  /** Owning Telegram user; NULL = legacy row, admin-only. */
  owner_telegram_user_id: number | null;
  visibility: ResourceVisibility;
  created_at: string;
  updated_at: string;
}

export interface UserDashboard {
  telegram_user_id: number;
  chat_id: number;
  message_id: number;
  screen_key: string;
  nav_stack?: string | null;
  updated_at: string;
}

export interface TaskLog {
  id: number;
  session_id: number;
  project_id: number | null;
  remote_path: string;
  task: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  size_bytes: number | null;
}

export interface SessionRecord {
  id: number;
  name: string;
  project_id: number | null;
  agent_type: AgentType;
  cwd: string;
  /** Owning Telegram user; NULL = legacy row migrated before multi-user support, admin-only. */
  owner_telegram_user_id: number | null;
  terminal_id: string | null;
  pid: number | null;
  status: SessionStatus;
  branch: string | null;
  waiting_reason: string | null;
  last_output: string | null;
  /** Absolute path of the session's .teleops/logs file (NULL for legacy sessions). */
  log_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionMessage {
  id: number;
  session_id: number;
  direction: MessageDirection;
  content: string;
  source: string | null;
  created_at: string;
}

export interface Approval {
  id: number;
  session_id: number | null;
  action_type: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  created_at: string;
  resolved_at: string | null;
}

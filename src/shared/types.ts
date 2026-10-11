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
  | "SSH_CONNECTED"
  | "SSH_DISCONNECTED";

export interface DomainEvent {
  type: EventType;
  session_id?: number;
  payload?: Record<string, unknown>;
  severity?: Severity;
  created_at: string;
}

export interface Project {
  id: number;
  name: string;
  root: string;
  /** NULL = legacy local root; set = path on that ssh host. */
  host_id: number | null;
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
  is_active: number;
  created_at: string;
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

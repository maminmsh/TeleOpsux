import { Config } from "../config/config";
import { DB } from "../db/database";
import { EventBus } from "../core/event-bus";
import { LogHub } from "../logger/logger";
import { SessionManager } from "../session/session-manager";
import { AdapterRegistry } from "../adapters/registry";
import { GitManager } from "../git/git-manager";
import { ServerMetrics, ProcessInfo } from "../monitor/server-monitor";
import { ApprovalManager } from "../approval/approval-manager";
import { PolicyEngine } from "../policy/policy-engine";
import { NotificationEngine } from "../notify/notification-engine";
import type { ExecRunner } from "../exec/exec-runner";
import type { ModuleErrorTracker } from "./error-tracker";
import type { HostService } from "../ssh/host-service";
import type { ProjectFiles } from "../session/project-files";
import type { ServerModeService } from "../server/server-mode";
import type { FullReport } from "../monitor/remote-monitor";
import type { CredentialService } from "../credentials/credential-service";
import type { PatValidator } from "../credentials/pat-validator";
import {
  isAdminUser as _isAdminUser,
  isAllowedUser as _isAllowedUser,
} from "../auth/access";

/** Common surface of the local and remote monitors. */
export interface MonitorLike {
  metrics(): Promise<ServerMetrics>;
  topProcesses(n?: number): Promise<ProcessInfo[]>;
  /** Only the remote monitor can produce the extended report. */
  fullReport?(): Promise<FullReport>;
  start(): void;
  stop(): void;
}

/**
 * Everything the UI / API layers can talk to. Core has no Telegram imports.
 * runner/git/monitor/projectFiles are mutable: ServerModeService hot-swaps
 * them when the active SSH host changes.
 */
export interface App {
  config: Config;
  db: DB;
  bus: EventBus;
  logs: LogHub;
  sessions: SessionManager;
  adapters: AdapterRegistry;
  git: GitManager;
  monitor: MonitorLike;
  approvals: ApprovalManager;
  policy: PolicyEngine;
  notifications: NotificationEngine;
  runner: ExecRunner;
  tracker: ModuleErrorTracker;
  hosts: HostService;
  credentials: CredentialService;
  /** Optional live "does this PAT work?" probe used by the /qoderkey flow. */
  patValidator: PatValidator;
  projectFiles: ProjectFiles | null;
  serverMode: ServerModeService;
}

export function isAllowedUser(app: App, userId: number | undefined): boolean {
  return _isAllowedUser(app, userId);
}

export function isAdminUser(app: App, userId: number | undefined): boolean {
  return _isAdminUser(app, userId);
}

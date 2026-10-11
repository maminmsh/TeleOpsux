/**
 * Smoke: boot modes + fake host fail path (plan verification §"host ساختگی").
 * Run: DATABASE_FILE=... LOG_ROOT=... TELEOPS_SECRET_KEY_FILE=... npx tsx scripts/smoke-modes.ts
 * Uses port 1 on 127.0.0.1 → guaranteed connection refused.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config/config";
import { LogHub } from "../src/logger/logger";
import { DB } from "../src/db/database";
import { EventBus } from "../src/core/event-bus";
import { Tmux } from "../src/session/tmux";
import { AdapterRegistry } from "../src/adapters/registry";
import { SessionManager } from "../src/session/session-manager";
import { GitManager } from "../src/git/git-manager";
import { ServerMonitor } from "../src/monitor/server-monitor";
import { ApprovalManager } from "../src/approval/approval-manager";
import { PolicyEngine } from "../src/policy/policy-engine";
import { NotificationEngine } from "../src/notify/notification-engine";
import { ModuleErrorTracker } from "../src/core/error-tracker";
import { HostService } from "../src/ssh/host-service";
import { LocalRunner } from "../src/exec/local-runner";
import { RemoteServerMonitor } from "../src/monitor/remote-monitor";
import { ServerModeService } from "../src/server/server-mode";
import { App } from "../src/core/container";

const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

async function main(): Promise<void> {
  const config = loadConfig();
  const logs = new LogHub(config.paths.log_root);
  const db = new DB(config.paths.database_file);
  const bus = new EventBus(db);
  const tracker = new ModuleErrorTracker(bus, logs.system);
  const hosts = new HostService(db, config.paths.secret_key_file);
  const localRunner = new LocalRunner();
  const adapters = new AdapterRegistry(config.agents);
  const sessions = new SessionManager(
    db, bus, new Tmux(config.sessions.tmux_prefix, localRunner), adapters, logs, config,
  );
  sessions.setTracker(tracker);
  const app: App = {
    config, db, bus, logs, sessions, adapters,
    git: new GitManager(localRunner),
    monitor: new ServerMonitor(bus, config),
    approvals: new ApprovalManager(db, bus, logs),
    policy: new PolicyEngine(config),
    notifications: new NotificationEngine(bus, config),
    runner: localRunner,
    tracker, hosts,
    projectFiles: null,
    serverMode: null as unknown as ServerModeService,
  };
  app.serverMode = new ServerModeService(app, hosts, tracker);

  ok(!app.sessions.remoteMode, "core-only boot: local transport");
  ok(hs(db) === 4, "migrations applied to fresh DB (user_version=4)");

  // fake host → switch to remote transport with unreachable endpoint
  const host = hosts.addHost({
    host: "127.0.0.1", port: 1, username: "nope", password: "nope", name: "smoke-fake", activate: true,
  });
  await app.serverMode.switchActiveHost(host.id);
  ok(app.sessions.remoteMode, "switchActiveHost → remoteMode true");
  ok(app.runner.kind === "ssh", "App.runner hot-swapped to ssh");
  ok(app.projectFiles !== null, "ProjectFiles attached in remote mode");
  ok(app.monitor instanceof RemoteServerMonitor, "monitor hot-swapped to RemoteServerMonitor");

  const t0 = Date.now();
  const m = await app.monitor.metrics();
  console.log(`      (metrics took ${Date.now() - t0}ms, cpu=${m.cpu_percent})`);
  ok(tracker.state("ssh") === "error" || tracker.recent("ssh", 1).length > 0,
    "ssh failure recorded in ModuleErrorTracker");

  // remote guard: session create outside a registered project must fail
  let guard = "";
  try {
    await sessions.create({ name: "x", project_id: null, agent: "shell", cwd: "/tmp" });
  } catch (e) {
    guard = (e as Error).message;
  }
  ok(/registered project|\/addproject/i.test(guard), `create() remote guard: ${guard.slice(0, 60)}`);

  await app.serverMode.switchActiveHost(null);
  ok(!app.sessions.remoteMode, "switchActiveHost(null) → back to local");
  ok(app.runner.kind === "local", "runner hot-swapped back to local");

  hosts.deleteHost(host.id);
  db.close();
  logs.close();
}

function hs(d: DB): number { return d.schemaVersion(); }

void main().catch((e) => { console.error("fatal:", e); process.exit(1); });

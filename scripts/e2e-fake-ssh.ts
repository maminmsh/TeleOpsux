/**
 * E2E over a REAL SSH transport — using an in-process ssh2 test server that
 * executes commands locally (the "remote" host is this same machine).
 * Covers: addHost → switchActiveHost → SshRunner → tmux new-session →
 * pipe-pane task log → task_logs row → memory.json → stop → finalize.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Server as SshServer, utils } from "ssh2";
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
import { ServerModeService } from "../src/server/server-mode";
import { App } from "../src/core/container";

const PORT = 22220;
const PASS = "e2e-secret-pass";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (c: boolean, label: string) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${label}`);
  if (!c) process.exitCode = 1;
};

function startFakeSshServer(root: string): Promise<SshServer> {
  const hostKey = utils.generateKeyPairSync("rsa", { bits: 2048, comment: "e2e" }).private;
  const server = new SshServer({ hostKeys: [hostKey] });
  server.on("connection", (conn) => {
    conn.on("authentication", (ctx) => {
      if (ctx.method === "none") return ctx.reject(["password"]);
      if (ctx.method === "password" && ctx.password === PASS) return ctx.accept();
      ctx.reject(["password"]);
    });
    conn.on("session", (accept) => {
      const sess = accept();
      sess.on("exec", (accept2, _reject2, info: { command: string }) => {
        const stream = accept2();
        const child = spawn("bash", ["-c", info.command], { cwd: root });
        child.stdout.on("data", (d) => stream.write(d));
        child.stderr.on("data", (d) => stream.stderr.write(d));
        stream.on("data", (d) => child.stdin.write(d));
        // ssh2 delivers inbound EOF as readable push(null) -> "end" event
        stream.on("end", () => child.stdin.end());
        stream.on("close", () => child.stdin.end());
        child.on("exit", (code) => {
          // real sshd closes the channel when the command exits, even if
          // daemons (tmux server) inherit the stdio pipes
          stream.exit(code ?? 0);
          stream.end();
        });
      });
      sess.on("shell", (accept2) => {
        const stream = accept2();
        const child = spawn("bash", ["-i"], { cwd: root });
        child.stdout.on("data", (d) => stream.write(d));
        child.stderr.on("data", (d) => stream.stderr.write(d));
        stream.on("data", (d) => child.stdin.write(d));
        stream.on("close", () => child.kill());
      });
    });
  });
  return new Promise((res) => server.listen(PORT, "127.0.0.1", () => res(server)));
}

async function main(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "teleops-e2e-"));
  const projDir = path.join(base, "srv", "project alpha"); // space + quotes stress
  fs.mkdirSync(projDir, { recursive: true });
  process.env.DATABASE_FILE = path.join(base, "t.db");
  process.env.LOG_ROOT = path.join(base, "logs");
  process.env.TELEOPS_SECRET_KEY_FILE = path.join(base, "k.key");

  const server = await startFakeSshServer(projDir);
  const config = loadConfig();
  config.sessions.tmux_prefix = "teleops-e2e-"; // never clash with a live TeleOps tmux server
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
    runner: localRunner, tracker, hosts,
    projectFiles: null,
    serverMode: null as unknown as ServerModeService,
  };
  app.serverMode = new ServerModeService(app, hosts, tracker);

  try {
    const test = await hosts.testConnection({ host: "127.0.0.1", port: PORT, username: "e2e", password: PASS });
    ok(test.ok, `testConnection over ssh2 server (tmux: ${test.tmux ?? "none"})`);

    const host = hosts.addHost({
      host: "127.0.0.1", port: PORT, username: "e2e", password: PASS, name: "e2e-fake", activate: true,
    });
    await app.serverMode.switchActiveHost(host.id);
    ok(app.sessions.remoteMode, "hot switch to ssh transport");

    const proj = db.createProject(path.basename(projDir), projDir, host.id);
    ok(!!db.getProject(proj.id), `project registered with host_id (root has space: "${projDir}")`);

    const s = await sessions.create({
      name: "e2e-shell", project_id: proj.id, agent: "shell", cwd: "/etc", // forced from DB row
    });
    ok(s.cwd === projDir, `create() forced cwd from project row → ${s.cwd}`);

    await sessions.start(s.id, `echo E2E_MARKER_$((40+2))`);
    ok(true, "session started via SSH+tmux");
    await sleep(6200); // > heartbeat_interval_seconds so a poll tick lands

    const logFiles = fs.readdirSync(path.join(projDir, ".teleops/logs"));
    ok(logFiles.length === 1, `pipe-pane log file created: ${logFiles[0] ?? ""}`);
    const content = logFiles.length ? fs.readFileSync(path.join(projDir, ".teleops/logs", logFiles[0]!), "utf8") : "";
    ok(/E2E_MARKER_42/.test(content), "agent output captured in remote log file");

    const memRaw = fs.readFileSync(path.join(projDir, ".teleops/memory.json"), "utf8");
    ok(/E2E_MARKER/.test(memRaw), "memory.json written with task");

    const tlog = db.listTaskLogs({ session_id: s.id }, 1)[0];
    ok(!!tlog && tlog.status === "STARTED" && !tlog.ended_at, `task_logs row open (${tlog?.status})`);

    const screen = await sessions.capture(s.id, 30);
    ok(/E2E_MARKER_42/.test(screen), "capturePane over SSH returns tmux screen");

    await sessions.stop(s.id);
    await sleep(500);
    const tlog2 = db.getTaskLog(tlog!.id)!;
    ok(tlog2.status === "STOPPED", `task_logs finalized (${tlog2.status}, ${tlog2.size_bytes} bytes)`);
    const mem2 = JSON.parse(fs.readFileSync(path.join(projDir, ".teleops/memory.json"), "utf8"));
    ok(mem2.entries[0]?.status === "STOPPED", "memory.json entry updated to final status");

    // crash path: kill tmux pane out from under the manager
    await sessions.start(s.id, "echo CRASH_TEST");
    const tmuxName = String(s.id);
    await new Tmux(config.sessions.tmux_prefix, localRunner).killSession(tmuxName);
    await sleep(6200); // > heartbeat_interval_seconds so a poll tick lands
    const after = db.getSession(s.id)!;
    ok(after.status === "CRASHED", `remote tmux killed → status ${after.status}`);
  } finally {
    try {
      await new Tmux(config.sessions.tmux_prefix, localRunner).killSession("1").catch(() => {});
    } catch { /* noop */ }
    app.serverMode.connection?.close();
    sessions.shutdown();
    db.close();
    logs.close();
    server.close();
    await sleep(300);
    fs.rmSync(base, { recursive: true, force: true });
    console.log("cleanup done");
  }
}

void main().catch((e) => { console.error("fatal:", e); process.exit(1); });

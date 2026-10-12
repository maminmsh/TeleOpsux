import { loadConfig } from "./config/config";
import { LogHub } from "./logger/logger";
import { DB } from "./db/database";
import { EventBus } from "./core/event-bus";
import { Tmux } from "./session/tmux";
import { AdapterRegistry } from "./adapters/registry";
import { SessionManager } from "./session/session-manager";
import { GitManager } from "./git/git-manager";
import { ServerMonitor } from "./monitor/server-monitor";
import { ApprovalManager } from "./approval/approval-manager";
import { PolicyEngine } from "./policy/policy-engine";
import { NotificationEngine } from "./notify/notification-engine";
import { ModuleErrorTracker } from "./core/error-tracker";
import { HostService } from "./ssh/host-service";
import { SecretBox } from "./shared/secret-box";
import { CredentialService } from "./credentials/credential-service";
import { PatValidator } from "./credentials/pat-validator";
import { LocalRunner } from "./exec/local-runner";
import { ServerModeService } from "./server/server-mode";
import { App } from "./core/container";
import { basename } from "./shared/paths";
import { TelegramController } from "./telegram/bot";
import { OutputHub } from "./web/output-hub";
import { TerminalService } from "./web/terminal-service";
import { MiniAppServer } from "./web/mini-app-server";
import { redactSecrets } from "./auth/access";

async function main(): Promise<void> {
  const config = loadConfig();
  const logs = new LogHub(config.paths.log_root);
  logs.system.info("starting TeleOps AI Command Center", { env: process.env.NODE_ENV });

  const db = new DB(config.paths.database_file);
  const bus = new EventBus(db);
  const tracker = new ModuleErrorTracker(bus, logs.system);
  const hosts = new HostService(db, config.paths.secret_key_file, config);

  // Per-user Qoder credentials: encrypted at rest, revealed only at launch.
  const credBox = new SecretBox(config.paths.secret_key_file);
  const credentials = new CredentialService(db, credBox);
  // Supported non-destructive check that a submitted PAT actually works, before
  // anything is written: `qoder --list-models` authenticates and exits.
  const qoderAgent = config.agents.qoder ?? { enabled: false, command: "qoder" };
  const patValidator = new PatValidator({
    command: qoderAgent.command,
    enabled: config.credentials.validate_pat && qoderAgent.enabled,
    timeoutSeconds: config.credentials.pat_validation_timeout_seconds,
  });

  // Everything starts on the LOCAL transport; ServerModeService hot-swaps to
  // SSH when an active host exists.
  const localRunner = new LocalRunner();
  const tmux = new Tmux(config.sessions.tmux_prefix, localRunner);
  const adapters = new AdapterRegistry(config.agents);
  const sessions = new SessionManager(db, bus, tmux, adapters, logs, config);
  sessions.setTracker(tracker);
  sessions.setCredentials(credentials);
  const git = new GitManager(localRunner, (info) =>
    tracker.report("git", info.stderr, { repo: basename(info.cwd), command: info.command }),
  );
  const monitor = new ServerMonitor(bus, config);
  const approvals = new ApprovalManager(db, bus, logs);
  const policy = new PolicyEngine(config);
  const notifications = new NotificationEngine(bus, config);

  const app: App = {
    config,
    db,
    bus,
    logs,
    sessions,
    adapters,
    git,
    monitor,
    approvals,
    policy,
    notifications,
    runner: localRunner,
    tracker,
    hosts,
    credentials,
    patValidator,
    projectFiles: null,
    serverMode: null as unknown as ServerModeService, // assigned below
  };
  app.serverMode = new ServerModeService(app, hosts, tracker);

  const activeHost = hosts.getActiveHost();
  if (activeHost) {
    try {
      await app.serverMode.switchActiveHost(activeHost.id);
      logs.system.info(`remote mode active — host "${activeHost.name}" (${activeHost.host})`);
    } catch (e) {
      tracker.report("ssh", e, { step: "startup_switch", host: activeHost.name });
      logs.system.warn(
        `could not switch to host "${activeHost.name}" at startup — ` +
          `SSH will keep retrying in the background.`,
      );
    }
  } else {
    // Seed projects from configured roots only in local mode (docs §41).
    for (const root of config.security.project_roots) {
      try {
        db.createProject(basename(root), root);
      } catch {
        /* already exists (unique name) — ignore */
      }
    }
    if (!(await tmux.available()))
      logs.system.warn("tmux not found — persistent AI sessions will be disabled. Install tmux.");
    // In remote mode, recover() is deferred to the SSH "connected" event.
    await sessions.recover();
  }

  notifications.start();
  app.serverMode.ensureMonitorRunning();

  let telegram: TelegramController | null = null;
  if (config.telegram.enabled && config.telegram.botToken) {
    telegram = new TelegramController(app);
    await telegram.start();
  } else {
    logs.system.warn(
      config.telegram.enabled
        ? "TELEGRAM_BOT_TOKEN not set — Telegram UI is disabled; core is running."
        : "Telegram disabled in config; core is running.",
    );
  }

  // Live Session Terminal Mini App — shares the EventBus, SessionManager and
  // SSH transport; every request is initData-authenticated server-side.
  const scrub = (t: string): string => credentials.redactAll(redactSecrets(t));
  const hub = new OutputHub(bus, scrub);
  const terminals = new TerminalService(app, hub);
  let webapp: MiniAppServer | null = null;
  if (config.webapp.enabled && config.webapp.url && config.telegram.botToken) {
    webapp = new MiniAppServer(app, hub, terminals);
    try {
      const bound = await webapp.listen();
      logs.system.info(
        `Mini App API listening on ${bound.host}:${bound.port} (public: ${config.webapp.url})`,
      );
    } catch (e) {
      webapp = null;
      logs.system.warn(`Mini App server disabled: ${(e as Error).message}`);
    }
  } else if (config.webapp.enabled && !config.webapp.url) {
    logs.system.warn(
      "webapp.url not set (TELEOPS_WEBAPP_URL) — the Open Session Terminal button is hidden.",
    );
  }

  if (config.security.allowed_users.length === 0)
    logs.system.warn("no allowed_users configured — nobody can use the bot. Set security.allowed_users.");
  if (config.security.admin_users === undefined && config.security.allowed_users.length > 1)
    logs.system.warn(
      "security.admin_users is not set — every allowed user has FULL admin access (legacy mode). " +
        "Set admin_users to enable per-user isolation.",
    );

  const shutdown = async (signal: string): Promise<void> => {
    logs.system.info(`received ${signal}, shutting down`);
    try {
      app.monitor.stop();
      app.serverMode.connection?.close();
      sessions.shutdown();
      if (webapp) await webapp.close();
      terminals.shutdown();
      hub.stop();
      if (telegram) await telegram.stop();
      logs.system.info("telegram bot stopped");
    } finally {
      db.close();
      logs.close();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (r) => logs.system.error("unhandled rejection", { r: String(r) }));

  logs.system.info("TeleOps is up.", {
    agents: adapters.ids(),
    mode: activeHost ? "remote" : "local",
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

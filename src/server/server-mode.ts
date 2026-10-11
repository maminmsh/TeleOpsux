import { Tmux } from "../session/tmux";
import { GitManager } from "../git/git-manager";
import { ProjectFiles } from "../session/project-files";
import { RemoteServerMonitor } from "../monitor/remote-monitor";
import { ServerMonitor } from "../monitor/server-monitor";
import { LocalRunner } from "../exec/local-runner";
import type { ExecRunner } from "../exec/exec-runner";
import { SshConnection } from "../ssh/ssh-connection";
import { SshRunner } from "../ssh/ssh-runner";
import { attachSshTelemetry } from "../ssh/telemetry";
import type { HostService } from "../ssh/host-service";
import type { ModuleErrorTracker } from "../core/error-tracker";
import type { App } from "../core/container";
import { basename } from "../shared/paths";

/**
 * Owns the local↔remote transport switch. All app objects are constructed
 * once with the LOCAL runner so the bot works without a host; switching the
 * active SSH host hot-swaps runner / tmux / git / monitor / projectFiles on
 * the shared App object — no restart, no TelegramController rebuild.
 */
export class ServerModeService {
  readonly localRunner = new LocalRunner();
  private conn: SshConnection | null = null;
  private monitorRunning = false;

  constructor(
    private app: App,
    private hosts: HostService,
    private tracker: ModuleErrorTracker,
  ) {}

  get connection(): SshConnection | null {
    return this.conn;
  }

  /** null → back to local transport (no active host). */
  async switchActiveHost(hostId: number | null): Promise<void> {
    const app = this.app;
    const wasRunning = this.monitorRunning;
    app.monitor.stop();
    this.conn?.close();
    this.conn = null;
    this.monitorRunning = false;

    let runner: ExecRunner;
    let monitor: App["monitor"];

    if (hostId === null) {
      runner = this.localRunner;
      monitor = new ServerMonitor(app.bus, app.config);
      this.applyTransport(runner, null);
    } else {
      const host = this.hosts.getHost(hostId);
      if (!host) throw new Error(`Host #${hostId} not found`);
      const conn = new SshConnection(this.hosts.getCredentials(host), {
        keepaliveMs: app.config.ssh.keepalive_seconds * 1000,
        readyTimeoutMs: app.config.ssh.ready_timeout_seconds * 1000,
      });
      attachSshTelemetry(conn, this.tracker, app.bus);
      this.conn = conn;
      runner = new SshRunner(conn, (cmd, message) =>
        this.tracker.report("ssh", message, { command: cmd }),
      );
      this.applyTransport(runner, hostId);
      monitor = new RemoteServerMonitor(app.bus, app.config, runner, this.tracker);

      // Session recovery only makes sense once SSH is actually connected
      // (lazy connect here — first command or poll triggers it).
      let recovered = false;
      conn.on("connected", () => {
        if (recovered) return;
        recovered = true;
        void this.afterFirstConnect();
      });
    }

    app.monitor = monitor;
    if (wasRunning) this.ensureMonitorRunning();
  }

  /**
   * Execute one non-interactive command against a specific registered host.
   *
   * The long-lived transport is intentionally global because it owns tmux and
   * the monitor.  Telegram requests, however, must not silently run on the
   * last administrator-selected host when a normal user has selected a
   * different private host.  A short-lived connection makes that boundary
   * explicit and is suitable for validation and the restricted file browser.
   */
  async execOnHost(hostId: number, cmd: string, args: string[], cwd?: string) {
    const host = this.hosts.getHost(hostId);
    if (!host) throw new Error(`Host #${hostId} not found`);
    const conn = new SshConnection(this.hosts.getCredentials(host), {
      keepaliveMs: this.app.config.ssh.keepalive_seconds * 1000,
      readyTimeoutMs: this.app.config.ssh.ready_timeout_seconds * 1000,
    });
    const runner = new SshRunner(conn);
    try {
      return await runner.exec(cmd, args, { cwd, timeoutMs: 15_000 });
    } finally {
      conn.close();
    }
  }

  ensureMonitorRunning(): void {
    this.monitorRunning = true;
    this.app.monitor.start();
  }

  private async afterFirstConnect(): Promise<void> {
    const app = this.app;
    try {
      if (!(await app.sessions.tmuxAvailable()))
        app.logs.system.warn(
          "tmux not found on remote host — sessions disabled. Install tmux on the server.",
        );
      await app.sessions.recover();
    } catch (e) {
      this.tracker.report("session", e, { step: "recover" });
    }
  }

  private applyTransport(runner: ExecRunner, hostId: number | null): void {
    const app = this.app;
    app.runner = runner;
    if (hostId === null) {
      app.projectFiles = null;
      app.sessions.attachHost(null);
    } else {
      const tmux = new Tmux(app.config.sessions.tmux_prefix, runner);
      const projectFiles = new ProjectFiles(runner, this.tracker);
      app.projectFiles = projectFiles;
      app.sessions.attachHost({ hostId, runner, tmux, projectFiles });
    }
    app.git = new GitManager(runner, (info) =>
      this.tracker.report("git", info.stderr, {
        repo: basename(info.cwd),
        command: info.command,
      }),
    );
  }
}

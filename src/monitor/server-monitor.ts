import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventBus } from "../core/event-bus";
import { Config } from "../config/config";
import { AlertStateMachine } from "./alerts";

const exec = promisify(execFile);

export interface ServerMetrics {
  cpu_percent: number;
  load: [number, number, number];
  ram_total_mb: number;
  ram_used_mb: number;
  ram_percent: number;
  swap_percent: number;
  disk_percent: number;
  disk_used_gb: number;
  disk_free_gb: number;
  /** Mount the disk_* fields refer to (remote monitor reports the worst one). */
  disk_mount?: string;
  uptime_seconds: number;
}

export interface ProcessInfo {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

interface CpuTimes {
  idle: number;
  total: number;
}

/**
 * Server Monitor (docs §17). Read-only collection from /proc and node:os.
 * Emits threshold alerts (docs §19) with hysteresis so a metric hovering at a
 * boundary does not flood Telegram.
 */
export class ServerMonitor {
  private lastCpu: CpuTimes | null = null;
  private timer: NodeJS.Timeout | null = null;
  private alerts = new AlertStateMachine();

  constructor(private bus: EventBus, private config: Config) {}

  private readCpuTimes(): CpuTimes | null {
    try {
      const line = fs
        .readFileSync("/proc/stat", "utf8")
        .split("\n")[0]!;
      const parts = line.replace(/^cpu\s+/, "").trim().split(/\s+/).map(Number);
      const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
      const total = parts.reduce((a, b) => a + (b || 0), 0);
      return { idle, total };
    } catch {
      return null;
    }
  }

  private cpuPercent(): number {
    const cur = this.readCpuTimes();
    if (!cur) return 0;
    if (!this.lastCpu) {
      this.lastCpu = cur;
      return 0;
    }
    const idleDelta = cur.idle - this.lastCpu.idle;
    const totalDelta = cur.total - this.lastCpu.total;
    this.lastCpu = cur;
    if (totalDelta <= 0) return 0;
    return Math.round((1 - idleDelta / totalDelta) * 100);
  }

  async metrics(): Promise<ServerMetrics> {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    let swapTotal = 0;
    let swapFree = 0;
    try {
      const info = fs.readFileSync("/proc/meminfo", "utf8");
      const st = /SwapTotal:\s+(\d+)/.exec(info)?.[1];
      const sf = /SwapFree:\s+(\d+)/.exec(info)?.[1];
      swapTotal = st ? parseInt(st, 10) * 1024 : 0;
      swapFree = sf ? parseInt(sf, 10) * 1024 : 0;
    } catch {
      /* ignore */
    }

    let disk = { percent: 0, usedGb: 0, freeGb: 0 };
    try {
      const { stdout } = await exec("df", ["-k", "/"]);
      const line = stdout.trim().split("\n")[1] ?? "";
      const cols = line.split(/\s+/);
      const blocks = parseInt(cols[1] ?? "0", 10);
      const used = parseInt(cols[2] ?? "0", 10);
      const avail = parseInt(cols[3] ?? "0", 10);
      const pct = parseInt((cols[4] ?? "0").replace("%", ""), 10);
      disk = {
        percent: Number.isFinite(pct) ? pct : Math.round((used / blocks) * 100) || 0,
        usedGb: +(used / 1024 / 1024).toFixed(1),
        freeGb: +(avail / 1024 / 1024).toFixed(1),
      };
    } catch {
      /* df unavailable */
    }

    const la = os.loadavg();
    return {
      cpu_percent: this.cpuPercent(),
      load: [
        +(la[0] ?? 0).toFixed(2),
        +(la[1] ?? 0).toFixed(2),
        +(la[2] ?? 0).toFixed(2),
      ],
      ram_total_mb: Math.round(totalMem / 1048576),
      ram_used_mb: Math.round(usedMem / 1048576),
      ram_percent: Math.round((usedMem / totalMem) * 100),
      swap_percent: swapTotal ? Math.round(((swapTotal - swapFree) / swapTotal) * 100) : 0,
      disk_percent: disk.percent,
      disk_used_gb: disk.usedGb,
      disk_free_gb: disk.freeGb,
      uptime_seconds: Math.round(os.uptime()),
    };
  }

  async topProcesses(n = 8): Promise<ProcessInfo[]> {
    try {
      const { stdout } = await exec("ps", [
        "-eo",
        "pid,user,pcpu,pmem,args",
        "--sort=-pcpu",
        "--headers",
      ]);
      return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, n)
        .map((l) => {
          const [pid, user, cpu, mem, ...rest] = l.split(/\s+/);
          return {
            pid: parseInt(pid ?? "0", 10),
            user: user ?? "?",
            cpu: parseFloat(cpu ?? "0") || 0,
            mem: parseFloat(mem ?? "0") || 0,
            command: rest.join(" ").slice(0, 60),
          };
        });
    } catch {
      return [];
    }
  }

  async services(): Promise<Array<{ name: string; state: string }>> {
    try {
      const { stdout } = await exec("systemctl", [
        "list-units",
        "--type=service",
        "--state=active,failed",
        "--no-legend",
        "--plain",
      ]);
      return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const parts = l.split(/\s+/);
          const name = (parts[0] ?? "").replace(".service", "");
          const state = parts[2] ?? parts[1] ?? "unknown";
          return { name, state };
        });
    } catch {
      return [];
    }
  }

  private checkAlerts(m: ServerMetrics): void {
    this.alerts.check(this.bus, this.config, m);
  }

  start(): void {
    if (this.timer) return;
    const interval = Math.max(5, this.config.monitor.interval_seconds) * 1000;
    // prime CPU delta sampler
    this.lastCpu = this.readCpuTimes();
    this.timer = setInterval(() => {
      void this.metrics().then((m) => this.checkAlerts(m));
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

import { EventBus } from "../core/event-bus";
import { Config } from "../config/config";
import type { ExecRunner } from "../exec/exec-runner";
import type { ModuleErrorTracker } from "../core/error-tracker";
import { AlertStateMachine } from "./alerts";
import type { ProcessInfo, ServerMetrics } from "./server-monitor";

export interface MountInfo {
  dev: string;
  size_gb: number;
  used_gb: number;
  free_gb: number;
  percent: number;
  mount: string;
}

export interface ServiceInfo {
  name: string;
  state: string;
  failed: boolean;
}

export interface FullReport extends ServerMetrics {
  hostname: string;
  user: string;
  cores: number;
  per_core_percent: number[];
  mounts: MountInfo[];
  processes: ProcessInfo[];
  services: ServiceInfo[];
  docker: { available: boolean; running: number };
  tmux_sessions: number;
  net_rates_kbps: { rx: number; tx: number } | null;
  /** True when SSH collection failed and this is the last known-good sample. */
  stale: boolean;
  collected_at: string;
  error?: string;
}

/** Static, TeleOps-authored collection script — single round-trip per cycle. */
const COLLECT_SCRIPT = [
  "echo '===HOST==='; hostname; id -un;",
  "echo '===UPTIME==='; cat /proc/uptime;",
  "echo '===CPU==='; grep -E '^cpu[0-9]+ ' /proc/stat; grep -E '^cpu ' /proc/stat; sleep 1; grep -E '^cpu[0-9]+ ' /proc/stat; grep -E '^cpu ' /proc/stat;",
  "echo '===MEM==='; grep -E '^(MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo;",
  "echo '===DISK==='; df -kP;",
  "echo '===LOAD==='; cat /proc/loadavg;",
  "echo '===PS==='; ps -eo pid,user,pcpu,pmem,args --sort=-pcpu --headers 2>/dev/null | head -8;",
  "echo '===SVC==='; systemctl list-units --type=service --state=active,failed --no-legend --plain 2>/dev/null | head -30;",
  "echo '===DOCKER==='; command -v docker >/dev/null 2>&1 && docker ps -q 2>/dev/null | wc -l || echo NO_DOCKER;",
  "echo '===NET==='; cat /proc/net/dev;",
  "echo '===TMUX==='; tmux ls 2>/dev/null | wc -l;",
].join(" ");

/** Real storage devices only: block devices (/dev/*) and network/virt FS types worth watching. */
const REAL_FS = /\/dev\/|^(zfs|btrfs|xfs|ext[234]|nfs|nfs4|cifs|virtiofs|fuseblk)/i;

function splitSections(out: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let cur = "";
  for (const line of out.split("\n")) {
    const m = /^===(\w+)===$/.exec(line.trim());
    if (m) {
      cur = m[1]!;
      map.set(cur, []);
    } else if (cur) {
      map.get(cur)!.push(line);
    }
  }
  return map;
}

function cpuPct(first: string[], second: string[]): { total: number; perCore: number[] } {
  const parse = (lines: string[]) => {
    const out = new Map<string, { idle: number; total: number }>();
    for (const l of lines) {
      const parts = l.trim().split(/\s+/);
      const label = parts[0];
      if (!label) continue;
      const nums = parts.slice(1).map(Number);
      const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
      const total = nums.reduce((a, b) => a + (b || 0), 0);
      out.set(label, { idle, total });
    }
    return out;
  };
  const a = parse(first);
  const b = parse(second);
  const pct = (key: string): number | null => {
    const x = a.get(key);
    const y = b.get(key);
    if (!x || !y) return null;
    const dTotal = y.total - x.total;
    if (dTotal <= 0) return 0;
    return Math.round((1 - (y.idle - x.idle) / dTotal) * 100);
  };
  const total = pct("cpu") ?? 0;
  const perCore: number[] = [];
  for (const key of b.keys()) {
    if (key === "cpu") continue;
    const v = pct(key);
    if (v !== null) perCore.push(v);
  }
  return { total, perCore };
}

function parseMounts(lines: string[]): MountInfo[] {
  const mounts: MountInfo[] = [];
  for (const l of lines.slice(1)) {
    const cols = l.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const [dev, blocks, used, avail, pctStr, mount] = cols as [string, string, string, string, string, string];
    if (!REAL_FS.test(dev)) continue;
    const size = parseInt(blocks, 10) || 0;
    mounts.push({
      dev,
      size_gb: +(size / 1024 / 1024).toFixed(1),
      used_gb: +(parseInt(used, 10) / 1024 / 1024).toFixed(1),
      free_gb: +(parseInt(avail, 10) / 1024 / 1024).toFixed(1),
      percent: parseInt(pctStr.replace("%", ""), 10) || 0,
      mount,
    });
  }
  return mounts;
}

function parseMem(lines: string[]) {
  const kv = new Map<string, number>();
  for (const l of lines) {
    const m = /^(\w+):\s+(\d+)/.exec(l.trim());
    if (m) kv.set(m[1]!, parseInt(m[2]!, 10) * 1024);
  }
  const total = kv.get("MemTotal") ?? 0;
  const avail = kv.get("MemAvailable") ?? kv.get("MemFree") ?? 0;
  const used = Math.max(0, total - avail);
  const swapTotal = kv.get("SwapTotal") ?? 0;
  const swapFree = kv.get("SwapFree") ?? 0;
  return {
    ram_total_mb: Math.round(total / 1048576),
    ram_used_mb: Math.round(used / 1048576),
    ram_percent: total ? Math.round((used / total) * 100) : 0,
    swap_percent: swapTotal ? Math.round(((swapTotal - swapFree) / swapTotal) * 100) : 0,
  };
}

function parseProcesses(lines: string[]): ProcessInfo[] {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
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
}

function parseServices(lines: string[]): ServiceInfo[] {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(/\s+/);
      return {
        name: (parts[0] ?? "").replace(".service", ""),
        state: parts[2] ?? parts[1] ?? "unknown",
        failed: /failed/i.test(l),
      };
    });
}

function netTotals(lines: string[]): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let found = false;
  for (const l of lines) {
    const m = /^\s*([^:\s]+):\s*(.+)$/.exec(l);
    if (!m || m[1] === "lo") continue;
    const cols = (m[2] ?? "").trim().split(/\s+/).map(Number);
    if (cols.length >= 9) {
      rx += cols[0] ?? 0;
      tx += cols[8] ?? 0;
      found = true;
    }
  }
  return found ? { rx, tx } : null;
}

/**
 * Remote Server Monitor: one batched exec per cycle against the active SSH
 * host. Every section parse is individually guarded — an absent docker or
 * systemctl must never fail the whole cycle.
 */
export class RemoteServerMonitor {
  private timer: NodeJS.Timeout | null = null;
  private alerts = new AlertStateMachine();
  private last: FullReport | null = null;
  private lastNet: { rx: number; tx: number; at: number } | null = null;
  private netRates: FullReport["net_rates_kbps"] = null;

  constructor(
    private bus: EventBus,
    private config: Config,
    private runner: ExecRunner,
    private tracker: ModuleErrorTracker,
  ) {}

  async fullReport(): Promise<FullReport> {
    const timeoutMs = (this.config.ssh.exec_timeout_seconds + 5) * 1000;
    let r: Awaited<ReturnType<ExecRunner["execScript"]>>;
    try {
      r = await this.runner.execScript(COLLECT_SCRIPT, { timeoutMs });
    } catch (e) {
      // transport-level throw (shouldn't happen — runner converts) must never
      // kill the poll cycle or the bot (plan: SSH down → degraded report).
      this.tracker.report("monitor", e);
      r = { code: null, stdout: "", stderr: String((e as Error).message ?? e) };
    }
    if (r.code === null || r.code === 124) {
      const error = r.stderr || "server metrics unavailable";
      this.tracker.report("monitor", error);
      if (this.last) return { ...this.last, stale: true, error };
      // No snapshot yet: degraded zero report so /server stays answerable.
      return { ...this.build(""), stale: true, error };
    }
    const rep = this.build(r.stdout);
    this.last = rep;
    return rep;
  }

  async metrics(): Promise<ServerMetrics> {
    const { cpu_percent, load, ram_total_mb, ram_used_mb, ram_percent, swap_percent, disk_percent, disk_used_gb, disk_free_gb, disk_mount, uptime_seconds } =
      await this.fullReport();
    return {
      cpu_percent,
      load,
      ram_total_mb,
      ram_used_mb,
      ram_percent,
      swap_percent,
      disk_percent,
      disk_used_gb,
      disk_free_gb,
      disk_mount,
      uptime_seconds,
    };
  }

  async topProcesses(n = 8): Promise<ProcessInfo[]> {
    try {
      return (await this.fullReport()).processes.slice(0, n);
    } catch {
      return this.last?.processes.slice(0, n) ?? [];
    }
  }

  async services(): Promise<ServiceInfo[]> {
    try {
      return (await this.fullReport()).services;
    } catch {
      return this.last?.services ?? [];
    }
  }

  private build(stdout: string): FullReport {
    const s = splitSections(stdout);
    const sec = (name: string): string[] => s.get(name) ?? [];

    const hostLines = sec("HOST").map((l) => l.trim()).filter(Boolean);
    const hostname = hostLines[0] ?? "?";
    const user = hostLines[1] ?? "?";

    const cpuLines = sec("CPU");
    // CPU section: per-core..., total, <sleep>, per-core..., total (blank-line-free stream)
    let first = cpuLines;
    let second = cpuLines;
    const totalIdx = cpuLines.findIndex((l) => /^cpu\s/.test(l.trim()));
    if (totalIdx >= 0) {
      first = cpuLines.slice(0, totalIdx + 1);
      second = cpuLines.slice(totalIdx + 1);
      if (second.length === 0) second = first;
    }
    const { total: cpuTotal, perCore } = cpuPct(first, second);

    const mem = parseMem(sec("MEM"));

    let uptime = 0;
    try {
      uptime = Math.round(parseFloat(sec("UPTIME")[0]?.trim().split(/\s+/)[0] ?? "0")) || 0;
    } catch {
      /* guard */
    }

    let load: [number, number, number] = [0, 0, 0];
    try {
      const parts = sec("LOAD")[0]?.trim().split(/\s+/) ?? [];
      load = [+(parseFloat(parts[0] ?? "0") || 0), +(parseFloat(parts[1] ?? "0") || 0), +(parseFloat(parts[2] ?? "0") || 0)];
    } catch {
      /* guard */
    }

    let mounts: MountInfo[] = [];
    try {
      mounts = parseMounts(sec("DISK"));
    } catch {
      /* guard */
    }
    const root = mounts.find((m) => m.mount === "/") ?? mounts[0];
    const worst = mounts.reduce<MountInfo | undefined>(
      (w, m) => (!w || m.percent > w.percent ? m : w),
      undefined,
    );

    let procs: ProcessInfo[] = [];
    try {
      procs = parseProcesses(sec("PS"));
    } catch {
      /* guard */
    }

    let svcs: ServiceInfo[] = [];
    try {
      svcs = parseServices(sec("SVC"));
    } catch {
      /* guard */
    }

    let docker = { available: false, running: 0 };
    try {
      const d = sec("DOCKER")[0]?.trim();
      if (d && d !== "NO_DOCKER") docker = { available: true, running: parseInt(d, 10) || 0 };
    } catch {
      /* guard */
    }

    let tmuxSessions = 0;
    try {
      tmuxSessions = parseInt(sec("TMUX")[0]?.trim() ?? "0", 10) || 0;
    } catch {
      /* guard */
    }

    let netRates = this.netRates;
    try {
      const totals = netTotals(sec("NET"));
      if (totals) {
        const now = Date.now();
        if (this.lastNet) {
          const dt = Math.max(1, now - this.lastNet.at) / 1000;
          netRates = {
            rx: Math.max(0, Math.round(((totals.rx - this.lastNet.rx) * 8) / dt / 1024)),
            tx: Math.max(0, Math.round(((totals.tx - this.lastNet.tx) * 8) / dt / 1024)),
          };
        }
        this.lastNet = { ...totals, at: now };
      }
    } catch {
      /* guard */
    }

    return {
      cpu_percent: cpuTotal,
      load,
      ...mem,
      disk_percent: worst?.percent ?? root?.percent ?? 0,
      disk_used_gb: worst?.used_gb ?? root?.used_gb ?? 0,
      disk_free_gb: worst?.free_gb ?? root?.free_gb ?? 0,
      disk_mount: worst?.mount ?? root?.mount,
      uptime_seconds: uptime,
      hostname,
      user,
      cores: perCore.length,
      per_core_percent: perCore,
      mounts,
      processes: procs,
      services: svcs,
      docker,
      tmux_sessions: tmuxSessions,
      net_rates_kbps: netRates,
      stale: false,
      collected_at: new Date().toISOString(),
    };
  }

  start(): void {
    if (this.timer) return;
    const interval = Math.max(10, this.config.monitor.interval_seconds) * 1000;
    this.timer = setInterval(() => {
      this.fullReport()
        .then((m) => this.alerts.check(this.bus, this.config, m))
        .catch(() => {
          /* reported inside fullReport */
        });
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

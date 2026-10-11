import { SessionRecord } from "../shared/types";
import { STATUS_EMOJI } from "../session/state-machine";
import { ServerMetrics, ProcessInfo } from "../monitor/server-monitor";
import type { FullReport } from "../monitor/remote-monitor";
import { GitStatus } from "../git/git-manager";

export function ago(iso: string): string {
  // SQLite datetimes ("YYYY-MM-DD HH:MM:SS") are UTC without a marker;
  // JS toISOString already carries the Z.
  const t = Date.parse(iso.includes("T") ? iso : iso + "Z");
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s} sec ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ago`;
}

export function sessionLine(
  s: SessionRecord,
  index: number,
  projectName?: string,
): string {
  const emoji = STATUS_EMOJI[s.status];
  const lines = [
    `${index}. ${s.name}`,
    `   Agent: ${s.agent_type}  ·  ${emoji} ${s.status}`,
    `   Project: ${projectName ?? "—"}  ·  Branch: ${s.branch ?? "—"}`,
    `   Last activity: ${ago(s.updated_at)}`,
  ];
  if (s.waiting_reason) lines.push(`   Waiting: ${s.waiting_reason.slice(0, 120)}`);
  return lines.join("\n");
}

export function sessionsList(
  sessions: SessionRecord[],
  projectName: (id: number | null) => string | undefined,
): string {
  if (sessions.length === 0) return "🤖 AI SESSIONS\n\nNo sessions yet.\nUse /new to create one.";
  const head = "🤖 AI SESSIONS\n";
  const body = sessions
    .map((s, i) => sessionLine(s, i + 1, s.project_id ? projectName(s.project_id) : undefined))
    .join("\n\n");
  return `${head}\n${body}`;
}

function bar(percent: number, width = 10): string {
  const filled = Math.round((percent / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function serverStatus(m: ServerMetrics, sessionCounts: Record<string, number>): string {
  const counts = sessionCounts;
  return [
    "🖥 SERVER STATUS",
    "",
    `CPU    ${bar(m.cpu_percent)} ${m.cpu_percent}%`,
    `RAM    ${bar(m.ram_percent)} ${m.ram_percent}% (${m.ram_used_mb}/${m.ram_total_mb} MB)`,
    `Disk   ${bar(m.disk_percent)} ${m.disk_percent}% (${m.disk_used_gb}G used, ${m.disk_free_gb}G free)`,
    `Load   ${m.load.join("  ")}`,
    `Swap   ${m.swap_percent}%   ·   Uptime ${Math.floor(m.uptime_seconds / 3600)}h`,
    "",
    `AI Sessions: 🟢 ${counts.WORKING ?? 0} working · 🟡 ${
      (counts.WAITING_INPUT ?? 0) + (counts.WAITING_APPROVAL ?? 0)
    } waiting · 🔴 ${counts.ERROR ?? 0} error`,
  ].join("\n");
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

export function serverStatusExtended(r: FullReport, sessionCounts: Record<string, number>): string {
  const head = [
    r.stale ? `🖥 SERVER STATUS (${r.hostname}) — ⚠ stale data` : `🖥 SERVER STATUS (${r.hostname})`,
    `User: ${r.user}  ·  Uptime: ${fmtUptime(r.uptime_seconds)}  ·  ${ago(r.collected_at)}`,
    r.stale && r.error ? `Error: ${r.error.slice(0, 160)}` : null,
    "",
    `CPU    ${bar(r.cpu_percent)} ${r.cpu_percent}%  (${r.cores} cores)`,
    ...chunk(r.per_core_percent, 6).map((row, i) => `  ${String(i * 6).padStart(2, "0")}: ${row.map((p) => `${p}%`).join(" ")}`),
    `RAM    ${bar(r.ram_percent)} ${r.ram_percent}% (${r.ram_used_mb}/${r.ram_total_mb} MB)  Swap ${r.swap_percent}%`,
    `Load   ${r.load.join("  ")}`,
    "",
    "Disks",
    ...r.mounts.map((m) => `  ${bar(m.percent, 8)} ${m.percent}%  ${m.mount} (${m.used_gb}/${m.size_gb}G, ${m.free_gb}G free)`),
    "",
    "Top processes (CPU%)",
    ...r.processes.slice(0, 5).map((p) => `  ${String(p.cpu).padStart(5, " ")}%  ${p.user.padEnd(8).slice(0, 8)} ${p.command}`),
    "",
    r.services.some((s) => s.failed)
      ? `Services: ❌ ${r.services.filter((s) => s.failed).map((s) => s.name).join(", ")}`
      : `Services: ✅ all active (${r.services.length} listed)`,
    r.docker.available ? `Docker: ${r.docker.running} running` : "Docker: n/a",
    r.net_rates_kbps ? `Net: ↓${r.net_rates_kbps.rx} kbps ↑${r.net_rates_kbps.tx} kbps` : "Net: (first sample)",
    `tmux: ${r.tmux_sessions} sessions`,
    "",
    `AI Sessions: 🟢 ${sessionCounts.WORKING ?? 0} working · 🟡 ${
      (sessionCounts.WAITING_INPUT ?? 0) + (sessionCounts.WAITING_APPROVAL ?? 0)
    } waiting · 🔴 ${sessionCounts.ERROR ?? 0} error`,
  ];
  return head.filter((l): l is string => l !== null).join("\n").replace(/\n{3,}/g, "\n\n");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function processesList(procs: ProcessInfo[]): string {
  if (procs.length === 0) return "TOP PROCESSES\n\n(no data)";
  const rows = procs.map((p) => `${p.command.padEnd(24).slice(0, 24)} ${p.cpu}% CPU`);
  return ["TOP PROCESSES", "", ...rows].join("\n");
}

export function gitStatusText(st: GitStatus): string {
  const head = `🌿 Git\n\nBranch: ${st.branch}` +
    (st.ahead || st.behind ? `  (↑${st.ahead} ↓${st.behind})` : "");
  if (st.clean) return `${head}\n\nWorking tree clean.`;
  return `${head}\n\nModified:\n${st.modified.map((m) => "  " + m).join("\n")}`;
}

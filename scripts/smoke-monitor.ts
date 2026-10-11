import { LocalRunner } from "../src/exec/local-runner";
import { RemoteServerMonitor } from "../src/monitor/remote-monitor";
import { loadConfig } from "../src/config/config";

async function main() {
  const runner = new LocalRunner();
  const cfg = loadConfig();
  const bus: any = { emit: (e: any) => console.log("event:", e.type, JSON.stringify(e.payload ?? {})) };
  const tracker: any = { report: (m: string, e: unknown) => console.log("tracker:", m, String(e)) };
  const mon = new RemoteServerMonitor(bus, cfg, runner, tracker);
  const r = await mon.fullReport();
  console.log(JSON.stringify({
    hostname: r.hostname, user: r.user, cpu: r.cpu_percent, cores: r.cores,
    per_core: r.per_core_percent.slice(0, 4), ram: `${r.ram_used_mb}/${r.ram_total_mb}MB ${r.ram_percent}%`,
    swap: r.swap_percent, load: r.load, uptime: r.uptime_seconds,
    mounts: r.mounts.map((m) => `${m.mount}:${m.percent}%`), worst_disk: `${r.disk_mount} ${r.disk_percent}%`,
    procs: r.processes.length, svcs: r.services.length, docker: r.docker, tmux: r.tmux_sessions, net: r.net_rates_kbps,
  }, null, 1));
  // second cycle to get CPU delta + net rate working
  const r2 = await mon.fullReport();
  console.log("2nd cpu:", r2.cpu_percent, "net:", r2.net_rates_kbps);
  process.exit(0);
}
main();

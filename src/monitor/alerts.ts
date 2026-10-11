import type { EventBus } from "../core/event-bus";
import type { Config } from "../config/config";
import type { ServerMetrics } from "./server-monitor";

/**
 * Threshold alert state machine with hysteresis, shared by the local and
 * remote monitors: a metric hovering at a boundary does not flood Telegram.
 */
export class AlertStateMachine {
  private fired = new Set<string>();

  check(bus: EventBus, config: Config, m: ServerMetrics): void {
    const cfg = config.monitor;
    const check = (
      key: string,
      value: number,
      warning: number,
      critical: number,
      type: Parameters<EventBus["emit"]>[0]["type"],
      payload: Record<string, unknown>,
    ) => {
      const over = value >= critical ? "critical" : value >= warning ? "warning" : null;
      if (!over) {
        this.fired.delete(key);
        return;
      }
      const firedKey = `${key}:${over}`;
      if (this.fired.has(firedKey)) return;
      this.fired.add(firedKey);
      bus.emit({
        type,
        payload: { ...payload, level: over, value },
        severity: over === "critical" ? "CRITICAL" : "WARNING",
      });
    };

    check("ram", m.ram_percent, cfg.ram_warning, cfg.ram_critical, "SERVER_LOW_MEMORY", {
      ram_percent: m.ram_percent,
    });
    check("disk", m.disk_percent, cfg.disk_warning, cfg.disk_critical, "SERVER_HIGH_DISK_USAGE", {
      disk_percent: m.disk_percent,
      used_gb: m.disk_used_gb,
      free_gb: m.disk_free_gb,
      ...(m.disk_mount ? { mount: m.disk_mount } : {}),
    });
    if (cfg.cpu_warning)
      check("cpu", m.cpu_percent, cfg.cpu_warning, cfg.cpu_critical, "SERVER_HIGH_CPU", {
        cpu_percent: m.cpu_percent,
      });
  }
}

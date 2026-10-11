import type { EventBus } from "./event-bus";
import type { Logger } from "../logger/logger";

export type ModuleName =
  | "ssh"
  | "session"
  | "git"
  | "monitor"
  | "config"
  | "db"
  | "telegram";

export interface ModuleError {
  module: ModuleName;
  message: string;
  context?: Record<string, unknown>;
  at: string;
}

const RING_CAP = 50;
const ERROR_WINDOW_MS = 5 * 60_000;

/**
 * Per-module ring buffer of recent errors, surfaced to the bus and the
 * system log. In-memory only (reboot loses detail; the bus persists
 * MODULE_ERROR events to session_events). Never throws.
 */
export class ModuleErrorTracker {
  private rings = new Map<ModuleName, ModuleError[]>();

  constructor(
    private bus: EventBus,
    private logs: Logger | { error: (m: string) => void },
  ) {}

  report(module: ModuleName, err: unknown, context?: Record<string, unknown>): void {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : JSON.stringify(err);
    const entry: ModuleError = { module, message, context, at: new Date().toISOString() };
    const ring = this.rings.get(module) ?? [];
    ring.unshift(entry);
    if (ring.length > RING_CAP) ring.length = RING_CAP;
    this.rings.set(module, ring);
    try {
      this.bus.emit({
        type: "MODULE_ERROR",
        severity: "ERROR",
        payload: { module, message, context: context ?? {} },
      });
    } catch {
      /* bus failure must not break the reporter */
    }
    try {
      this.logs.error(`[${module}] ${message}`);
    } catch {
      /* noop */
    }
  }

  /** "error" when the module reported within the last 5 minutes. */
  state(module: ModuleName): "ok" | "error" {
    const last = this.rings.get(module)?.[0];
    if (!last) return "ok";
    return Date.now() - Date.parse(last.at) < ERROR_WINDOW_MS ? "error" : "ok";
  }

  recent(module?: ModuleName, limit = 5): ModuleError[] {
    if (module) return (this.rings.get(module) ?? []).slice(0, limit);
    const all: ModuleError[] = [];
    for (const [name, ring] of this.rings) {
      for (const e of ring) all.push({ ...e, module: name });
    }
    all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return all.slice(0, limit);
  }

  modules(): ModuleName[] {
    return ["ssh", "session", "git", "monitor", "config", "db", "telegram"];
  }

  count24h(module: ModuleName): number {
    const cutoff = Date.now() - 24 * 3600_000;
    return (this.rings.get(module) ?? []).filter((e) => Date.parse(e.at) > cutoff).length;
  }
}

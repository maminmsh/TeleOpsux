import { EventBus } from "../core/event-bus";
import { Config } from "../config/config";
import { DomainEvent } from "../shared/types";

export type NotifySink = (event: DomainEvent, rendered: string) => void;

/**
 * Notification Engine (docs §13/§39). Decides which domain events deserve a
 * user-facing notification based on configured rules, renders a short digest,
 * and hands it to registered sinks (Telegram being one). Core stays unaware of
 * the transport. Rate/coalescing concerns are handled by the transport layer.
 */
export class NotificationEngine {
  private sinks: NotifySink[] = [];

  constructor(private bus: EventBus, private config: Config) {}

  registerSink(sink: NotifySink): void {
    this.sinks.push(sink);
  }

  /** Subscribe to every event type that has a configured rule. */
  start(): void {
    const rules = this.config.notifications.rules ?? {};
    for (const type of Object.keys(rules)) {
      this.bus.on(type as DomainEvent["type"], (e) => {
        const text = this.render(e);
        if (text) for (const sink of this.sinks) sink(e, text);
      });
    }
  }

  private render(e: DomainEvent): string | null {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const sid = e.session_id != null ? ` #${e.session_id}` : "";
    switch (e.type) {
      case "APPROVAL_REQUIRED":
        return `⚠️ Agent needs approval${sid}\n${String(p.reason ?? p.action ?? "")}`;
      case "USER_INPUT_REQUIRED":
        return `❓ Agent has a question${sid}\n${String(p.question ?? "")}`;
      case "COMMAND_FAILED":
      case "TEST_FAILED":
      case "BUILD_FAILED":
        return `❌ Failure${sid} (${e.type})\n${String(p.detail ?? "")}`;
      case "PROCESS_CRASHED":
        return `💥 Process crashed${sid}\n${String(p.reason ?? "")}`;
      case "SESSION_FINISHED":
        return `✅ Session finished${sid}`;
      case "SESSION_STOPPED":
        return `⏹ Session stopped${sid}`;
      case "SERVER_LOW_MEMORY":
        return `🚨 SERVER: RAM ${p.value}%`;
      case "SERVER_HIGH_DISK_USAGE":
        return `🚨 SERVER: Disk ${p.value}% (free ${p.free_gb ?? "?"} GB)`;
      case "SERVER_HIGH_CPU":
        return `🚨 SERVER: CPU ${p.value}%`;
      default:
        return null;
    }
  }
}

import type { EventBus } from "../core/event-bus";
import type { ModuleErrorTracker } from "../core/error-tracker";
import type { SshConnection } from "./ssh-connection";

/** Reports connect/disconnect/exec failures to the tracker and the bus. */
export function attachSshTelemetry(
  conn: SshConnection,
  tracker: ModuleErrorTracker,
  bus: EventBus,
): void {
  conn.on("connected", () => bus.emit({ type: "SSH_CONNECTED", severity: "INFO" }));
  conn.on("disconnected", () => {
    tracker.report("ssh", conn.lastErrorMessage || "connection closed");
    bus.emit({ type: "SSH_DISCONNECTED", severity: "WARNING" });
  });
  conn.on("error", (e: Error) => tracker.report("ssh", e));
}

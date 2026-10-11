import { EventEmitter } from "node:events";
import { DB } from "../db/database";
import { DomainEvent, EventType, Severity } from "../shared/types";

export interface EmitInput {
  type: EventType;
  session_id?: number;
  payload?: Record<string, unknown>;
  severity?: Severity;
}

/**
 * In-process event bus (docs §4.3 / §52). Producers emit domain events; the
 * notification engine and session manager subscribe. Events are persisted for
 * the timeline (§60) and audit. This keeps the core decoupled from Telegram.
 */
export class EventBus {
  private emitter = new EventEmitter();
  private db: DB;

  constructor(db: DB) {
    this.db = db;
    this.emitter.setMaxListeners(100);
  }

  emit(input: EmitInput): DomainEvent {
    const event: DomainEvent = {
      type: input.type,
      session_id: input.session_id,
      payload: input.payload,
      severity: input.severity ?? "INFO",
      created_at: new Date().toISOString(),
    };
    this.db.addEvent({
      session_id: input.session_id,
      type: input.type,
      payload: input.payload,
      severity: event.severity,
    });
    this.emitter.emit("event", event);
    this.emitter.emit(input.type, event);
    return event;
  }

  on(type: EventType | "event", handler: (e: DomainEvent) => void): void {
    this.emitter.on(type, handler);
  }

  off(type: EventType | "event", handler: (e: DomainEvent) => void): void {
    this.emitter.off(type, handler);
  }
}

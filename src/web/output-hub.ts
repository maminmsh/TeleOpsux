import { EventBus } from "../core/event-bus";
import { DomainEvent } from "../shared/types";

/**
 * In-memory live output buffer per session (docs §52 event flow, UI-side).
 * The EventBus keeps producing SESSION_OUTPUT chunks and lifecycle events;
 * the Mini App server subscribes here instead of polling tmux itself, so the
 * Telegram UI and the Web UI consume the SAME stream. Every line carries a
 * monotonically increasing per-session `seq`, which lets a reconnecting
 * client say "after=<seq>" and resume with no duplicates and no gaps (within
 * the ring's retention window).
 */

export type LineSource = "agent" | "shell" | "system";

export interface HubLine {
  seq: number;
  at: string;
  source: LineSource;
  text: string;
}

export type LineListener = (line: HubLine) => void;

const RING_CAP = 500;
const MAX_LINES_PER_APPEND = 200;

interface Ring {
  lines: HubLine[];
  nextSeq: number;
  /** True once a live event has fed this ring (then we never seed again). */
  live: boolean;
  listeners: Set<LineListener>;
}

export const LIFECYCLE_TEXT: Record<string, string> = {
  SESSION_CREATED: "session created",
  SESSION_STARTED: "agent started",
  SESSION_STOPPED: "session stopped",
  SESSION_FINISHED: "session finished",
  SESSION_RECONNECTED: "TeleOps re-attached to the running agent",
  PROCESS_CRASHED: "agent process crashed",
};

/**
 * Stored output history (last `count` lines, chronological) rebuilt from the
 * PERSISTED domain events — the same view both the Mini App "Last 50 lines"
 * and the Telegram button render. db.listEvents returns DESC; shell-pane
 * output never reaches the bus, so this is agent + system lines only.
 */
export function storedHistoryLines(
  events: DomainEvent[],
  count = 50,
): { at: string; source: LineSource; text: string }[] {
  const lines: { at: string; source: LineSource; text: string }[] = [];
  for (const e of [...events].reverse()) {
    if (e.type === "SESSION_OUTPUT") {
      const chunk = String(e.payload?.chunk ?? "");
      for (const l of chunk.split("\n"))
        lines.push({ at: e.created_at, source: "agent", text: l });
    } else {
      const t = LIFECYCLE_TEXT[e.type];
      if (t) lines.push({ at: e.created_at, source: "system", text: t });
    }
  }
  return lines.slice(-count);
}

export class OutputHub {
  private rings = new Map<number, Ring>();
  private busHandler: (e: DomainEvent) => void;

  constructor(
    private bus: EventBus,
    /** Scrub pipeline (redactSecrets + stored-key redaction). */
    private sanitize: (text: string) => string = (t) => t,
  ) {
    this.busHandler = (e) => this.onEvent(e);
    // ONE subscription: the bus fires "event" for every type — subscribing to
    // both would double-append SESSION_OUTPUT chunks.
    bus.on("event", this.busHandler);
  }

  stop(): void {
    this.bus.off("event", this.busHandler);
  }

  private ring(id: number): Ring {
    let r = this.rings.get(id);
    if (!r) {
      r = { lines: [], nextSeq: 1, live: false, listeners: new Set() };
      this.rings.set(id, r);
    }
    return r;
  }

  private onEvent(e: DomainEvent): void {
    if (e.session_id == null) return;
    if (e.type === "SESSION_OUTPUT") {
      const chunk = (e.payload?.chunk as string) ?? "";
      if (chunk.trim()) this.append(e.session_id, "agent", chunk, true);
      return;
    }
    const text = LIFECYCLE_TEXT[e.type];
    if (text) this.append(e.session_id, "system", text, true);
  }

  /** Append one (possibly multi-line) block; returns the last assigned seq. */
  append(sessionId: number, source: LineSource, text: string, markLive = false): number {
    const r = this.ring(sessionId);
    const at = new Date().toISOString();
    const parts = this.sanitize(text).split("\n").slice(0, MAX_LINES_PER_APPEND);
    let seq = r.nextSeq - 1;
    for (const line of parts) {
      seq = r.nextSeq++;
      r.lines.push({ seq, at, source, text: line });
    }
    if (r.lines.length > RING_CAP) r.lines.splice(0, r.lines.length - RING_CAP);
    if (markLive) r.live = true;
    // snapshot the listener set: a handler may unsubscribe during dispatch
    for (const l of [...r.listeners]) {
      try {
        l({ seq, at, source, text: parts.join("\n") });
      } catch {
        /* a dead stream must never stall the hub */
      }
    }
    return seq;
  }

  /**
   * Last `count` lines in chronological order. When the ring has never seen
   * a live event for this session (e.g. after a TeleOps restart), the stored
   * pane tail `fallback` is seeded once so the client still sees context and
   * the `seq` cursor stays coherent for the follow-up live stream.
   */
  snapshot(sessionId: number, count: number, fallback?: string): HubLine[] {
    const r = this.ring(sessionId);
    if (!r.live && !r.lines.length && fallback && fallback.trim()) {
      this.append(sessionId, "agent", fallback, false);
    }
    return r.lines.slice(-count);
  }

  /** All retained lines with seq > afterSeq, in order. */
  since(sessionId: number, afterSeq: number): HubLine[] {
    const r = this.ring(sessionId);
    return r.lines.filter((l) => l.seq > afterSeq);
  }

  lastSeq(sessionId: number): number {
    return this.ring(sessionId).nextSeq - 1;
  }

  subscribe(sessionId: number, listener: LineListener): () => void {
    const r = this.ring(sessionId);
    r.listeners.add(listener);
    return () => r.listeners.delete(listener);
  }

  subscriberCount(sessionId: number): number {
    return this.ring(sessionId).listeners.size;
  }

  /** Drop a session's buffer entirely (deleted session / shutdown). */
  forget(sessionId: number): void {
    this.rings.delete(sessionId);
  }
}

import { EventBus } from "../core/event-bus";
import { DomainEvent } from "../shared/types";

/**
 * In-memory live output buffer per CHANNEL (docs §52 event flow, UI-side).
 * Channels are string-keyed: `s<sessionId>` for the agent+system stream fed
 * by the EventBus, and `t<telegramUserId>` for a user's PERSONAL terminal —
 * the terminal is independent of AI sessions, so it must not share a ring
 * with any session. The Mini App server subscribes here instead of polling
 * tmux itself, so the Telegram UI and the Web UI consume the SAME stream.
 * Every line carries a monotonically increasing per-channel `seq`, which lets
 * a reconnecting client say "after=<seq>" and resume with no duplicates and
 * no gaps (within the ring's retention window).
 */
export type HubKey = string;

export const sessionKey = (sessionId: number): HubKey => `s${sessionId}`;
export const terminalKey = (userId: number): HubKey => `t${userId}`;

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
  private rings = new Map<HubKey, Ring>();
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

  private ring(key: HubKey): Ring {
    let r = this.rings.get(key);
    if (!r) {
      r = { lines: [], nextSeq: 1, live: false, listeners: new Set() };
      this.rings.set(key, r);
    }
    return r;
  }

  private onEvent(e: DomainEvent): void {
    if (e.session_id == null) return;
    const key = sessionKey(e.session_id);
    if (e.type === "SESSION_OUTPUT") {
      const chunk = (e.payload?.chunk as string) ?? "";
      if (chunk.trim()) this.append(key, "agent", chunk, true);
      return;
    }
    const text = LIFECYCLE_TEXT[e.type];
    if (text) this.append(key, "system", text, true);
  }

  /** Append one (possibly multi-line) block; returns the last assigned seq. */
  append(key: HubKey, source: LineSource, text: string, markLive = false): number {
    const r = this.ring(key);
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
  snapshot(key: HubKey, count: number, fallback?: string): HubLine[] {
    const r = this.ring(key);
    if (!r.live && !r.lines.length && fallback && fallback.trim()) {
      this.append(key, "agent", fallback, false);
    }
    return r.lines.slice(-count);
  }

  /** All retained lines with seq > afterSeq, in order. */
  since(key: HubKey, afterSeq: number): HubLine[] {
    const r = this.ring(key);
    return r.lines.filter((l) => l.seq > afterSeq);
  }

  lastSeq(key: HubKey): number {
    return this.ring(key).nextSeq - 1;
  }

  subscribe(key: HubKey, listener: LineListener): () => void {
    const r = this.ring(key);
    r.listeners.add(listener);
    return () => r.listeners.delete(listener);
  }

  subscriberCount(key: HubKey): number {
    return this.ring(key).listeners.size;
  }

  /** Drop a channel's buffer entirely (deleted session / shutdown). */
  forget(key: HubKey): void {
    this.rings.delete(key);
  }
}

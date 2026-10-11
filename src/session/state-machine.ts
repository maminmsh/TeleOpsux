import { SessionStatus } from "../shared/types";

// Allowed transitions per the state machine in docs §42.
const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  CREATED: ["STARTING", "STOPPED"],
  STARTING: ["WORKING", "ERROR", "STOPPED", "CRASHED"],
  WORKING: [
    "WAITING_INPUT",
    "WAITING_APPROVAL",
    "ERROR",
    "FINISHED",
    "STOPPING",
    "CRASHED",
  ],
  WAITING_INPUT: ["WORKING", "STOPPING", "ERROR", "CRASHED", "FINISHED"],
  WAITING_APPROVAL: ["WORKING", "STOPPING", "ERROR", "CRASHED", "FINISHED"],
  ERROR: ["WORKING", "STOPPING", "STOPPED", "CRASHED"],
  STOPPING: ["STOPPED", "CRASHED"],
  STOPPED: ["STARTING"],
  FINISHED: ["STARTING"],
  CRASHED: ["STARTING", "STOPPED"],
};

export const ACTIVE_STATUSES: SessionStatus[] = [
  "STARTING",
  "WORKING",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
];

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? from === to;
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to) && from !== to) {
    throw new Error(`Invalid session transition ${from} -> ${to}`);
  }
}

export const STATUS_EMOJI: Record<SessionStatus, string> = {
  CREATED: "⚪",
  STARTING: "🔵",
  WORKING: "🟢",
  WAITING_INPUT: "🟡",
  WAITING_APPROVAL: "🟡",
  ERROR: "🔴",
  STOPPING: "⚫",
  STOPPED: "⚫",
  FINISHED: "✅",
  CRASHED: "💥",
};

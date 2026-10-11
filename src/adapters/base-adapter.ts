import {
  AgentAdapter,
  CreateSessionOptions,
  ErrorSignal,
  SessionSummary,
  WaitingState,
} from "./agent-adapter";
import { SessionStatus } from "../shared/types";

const TRAILING = /[\r\n]+$/;

/** Tail lines that actually contain text, most-recent first window kept small. */
export function tailLines(output: string, n = 40): string[] {
  return output
    .replace(TRAILING, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/g, ""))
    .slice(-n);
}

export function lastNonEmpty(output: string): string {
  const lines = tailLines(output, 15).filter((l) => l.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

/**
 * Generic interactive-CLI adapter. It is the safest default and the base for
 * more specific adapters — a bare shell prompt or any TUI that prints text.
 */
export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract launchCommand(options: CreateSessionOptions): string;

  protected approvalPatterns: RegExp[] = [
    /\b(yes\/no|y\/n|\[y\/n\]|allow\b|approve|permission|required)\b/i,
    /\b(do you (want|need) to (proceed|continue|allow))\b/i,
    /\bwaiting for (approval|confirmation)\b/i,
    /\border to (kill|delete|remove)/i,
  ];
  protected inputPatterns: RegExp[] = [
    /\b(press enter to continue|press any key)\b/i,
    /\bhow (would|should)\b/i,
    /\b(which|choose|select) .*\??$/i,
    /\bawaiting (user )?(input|response|instruction)\b/i,
    /[?？]\s*$/m,
    />\s*_?\s*$/,
  ];
  protected workingHints: RegExp[] = [
    /\b(working|running|building|testing|analyzing|thinking|reading|processing)\b/i,
    /[█▓▒░]\s*\d+%/i,
  ];
  protected errorPatterns: RegExp[] = [
    /\b(error|exception|traceback|failed|failure|panic)\b/i,
    /\b(\d+ (tests? )?failed)\b/i,
    /\bexit(ed)? (with )?(code|status) [1-9]\b/i,
  ];

  detectWaiting(output: string): WaitingState | null {
    const tail = tailLines(output, 12).join("\n");
    for (const re of this.approvalPatterns) {
      const m = tail.match(re);
      if (m) return { kind: "approval", reason: m[0] };
    }
    const last = lastNonEmpty(output);
    for (const re of this.inputPatterns) {
      if (re.test(last)) return { kind: "input", reason: last.slice(0, 300) };
    }
    return null;
  }

  detectError(output: string): ErrorSignal | null {
    const tail = tailLines(output, 20).join("\n");
    const testFail = tail.match(/(\d+)\s+(tests?\s+)?failed/i);
    if (testFail)
      return { kind: "test_failure", detail: testFail[0] };
    if (/\b(build|compilation)\b.*\bfail/i.test(tail))
      return { kind: "build_failure", detail: "build failed" };
    if (/\berror\b/i.test(tail))
      return { kind: "generic", detail: lastNonEmpty(output).slice(0, 300) };
    return null;
  }

  classifyStatus(output: string, alive: boolean): SessionStatus {
    if (!alive) return "CRASHED";
    const waiting = this.detectWaiting(output);
    if (waiting)
      return waiting.kind === "approval" ? "WAITING_APPROVAL" : "WAITING_INPUT";
    const tail = tailLines(output, 8).join("\n");
    if (this.errorPatterns.some((re) => re.test(tail))) return "ERROR";
    if (this.workingHints.some((re) => re.test(tail))) return "WORKING";
    return "WORKING";
  }

  summarize(output: string, meta: { startedAtMs: number }): SessionSummary {
    const lines = output.split(/\r?\n/);
    const completed = lines
      .filter((l) => /^\s*[✅✓]\s+/.test(l))
      .map((l) => l.trim())
      .slice(-8);
    const failed = lines
      .filter((l) => /^\s*[❌✗]\s+/.test(l) || /\bfailed\b/i.test(l))
      .map((l) => l.trim())
      .slice(-8);
    const waiting = this.detectWaiting(output);
    const filesChanged = new Set(
      lines
        .flatMap((l) => l.match(/[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|sql|md)/g) ?? []),
    );
    const commit = output.match(
      /\b([0-9a-f]{7,40})\b(?=.*(commit|pushed))/i,
    )?.[1];
    return {
      agent: this.name,
      duration: formatDuration(Date.now() - meta.startedAtMs),
      completed,
      failed,
      current: waiting
        ? waiting.kind === "approval"
          ? "Waiting for approval"
          : "Waiting for user input"
        : this.classifyStatus(output, true),
      lastQuestion: waiting && waiting.kind === "input" ? waiting.reason : null,
      changedFiles: filesChanged.size || null,
      lastCommit: commit ?? null,
    };
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

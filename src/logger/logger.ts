import fs from "node:fs";
import path from "node:path";

export type LogKind = "system" | "session" | "audit";

const LEVEL_TAG = {
  DEBUG: "DEBUG",
  INFO: "INFO",
  WARN: "WARN",
  ERROR: "ERROR",
} as const;
type Level = keyof typeof LEVEL_TAG;

function ts(): string {
  return new Date().toISOString();
}

/**
 * Three log streams (docs §49): SYSTEM LOG, SESSION LOG, AUDIT LOG.
 * Writes are appended to files under LOG_ROOT and mirrored to stdout for system logs.
 */
export class Logger {
  private dir: string;
  private stream: fs.WriteStream;
  private kind: LogKind;

  constructor(kind: LogKind, logRoot: string) {
    this.kind = kind;
    this.dir = logRoot;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${kind}.log`);
    this.stream = fs.createWriteStream(file, { flags: "a" });
  }

  private write(line: string, toConsole: boolean): void {
    this.stream.write(line + "\n");
    if (toConsole) process.stdout.write(line + "\n");
  }

  log(level: Level, message: string, meta?: unknown): void {
    const suffix =
      meta === undefined ? "" : " " + safeJson(meta);
    const line = `${ts()} [${LEVEL_TAG[level]}] ${message}${suffix}`;
    this.write(line, this.kind === "system");
  }

  debug(message: string, meta?: unknown): void {
    this.log("DEBUG", message, meta);
  }
  info(message: string, meta?: unknown): void {
    this.log("INFO", message, meta);
  }
  warn(message: string, meta?: unknown): void {
    this.log("WARN", message, meta);
  }
  error(message: string, meta?: unknown): void {
    this.log("ERROR", message, meta);
  }

  /** Structured audit record: who did what to which session (docs §31/§32). */
  audit(actor: string, action: string, detail?: unknown): void {
    const line = `${ts()} [AUDIT] actor=${actor} action=${action}${
      detail === undefined ? "" : " " + safeJson(detail)
    }`;
    this.write(line, false);
  }

  /** Append raw agent output to the session log (docs §40 — full log on server). */
  sessionOutput(sessionId: number, chunk: string): void {
    const line = `${ts()} [SESSION ${sessionId}]\n${chunk}`;
    this.write(line, false);
  }

  close(): void {
    this.stream.end();
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class LogHub {
  readonly system: Logger;
  readonly session: Logger;
  readonly audit: Logger;

  constructor(logRoot: string) {
    this.system = new Logger("system", logRoot);
    this.session = new Logger("session", logRoot);
    this.audit = new Logger("audit", logRoot);
  }

  close(): void {
    this.system.close();
    this.session.close();
    this.audit.close();
  }
}

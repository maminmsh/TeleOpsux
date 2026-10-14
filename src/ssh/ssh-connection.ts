import { EventEmitter } from "node:events";
import { Client } from "ssh2";
import type { Client as Ssh2Client } from "ssh2";
import type { ExecOptions, ExecResult } from "../exec/exec-runner";

export interface SshHostCredentials {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}

export interface SshConnectionOptions {
  keepaliveMs?: number;
  readyTimeoutMs?: number;
  maxBackoffMs?: number;
}

/**
 * A single long-lived ssh2 connection shared by all subsystems (tmux polling,
 * git, monitor, file writes). Lazy connect + exponential reconnect backoff;
 * a failed attempt is memoized for the backoff window so a 5 s poller does not
 * hammer the server. Emits: "connected" | "disconnected" | "error".
 */
export class SshConnection extends EventEmitter {
  private client: Ssh2Client | null = null;
  private connected = false;
  private connecting: Promise<Ssh2Client> | null = null;
  private backoffMs = 1_000;
  private nextAttemptAt = 0;
  private lastError = "";
  private closed = false;

  private readonly keepaliveMs: number;
  private readonly readyTimeoutMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private creds: SshHostCredentials,
    opts: SshConnectionOptions = {},
  ) {
    super();
    this.keepaliveMs = opts.keepaliveMs ?? 15_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.on("error", () => {
      /* keep EventEmitter from throwing on unhandled 'error' when no listener yet */
    });
  }

  get state(): "connected" | "backoff" | "idle" {
    if (this.connected) return "connected";
    return Date.now() < this.nextAttemptAt ? "backoff" : "idle";
  }

  get lastErrorMessage(): string {
    return this.lastError;
  }

  updateCredentials(creds: SshHostCredentials): void {
    this.creds = creds;
    this.resetBackoff();
    if (this.client) {
      const old = this.client;
      this.client = null;
      this.connected = false;
      try {
        old.end();
      } catch {
        /* already gone */
      }
    }
  }

  /** Lazy connect; concurrent callers share a single pending attempt. */
  async ready(): Promise<Ssh2Client> {
    if (this.closed) throw new Error("ssh connection closed");
    if (this.connected && this.client) return this.client;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.nextAttemptAt) {
      const wait = Math.ceil((this.nextAttemptAt - Date.now()) / 1000);
      throw new Error(
        `ssh reconnect backoff: retry in ~${wait}s (last error: ${this.lastError || "unknown"})`,
      );
    }
    this.connecting = this.openClient().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Run a fully-formed (and already-quoted) shell line on the server.
   * On a transport error the client is invalidated and the exec retried once.
   */
  async execLine(line: string, opts?: ExecOptions): Promise<ExecResult> {
    try {
      const client = await this.ready();
      try {
        return await this.execOnce(client, line, opts);
      } catch (e) {
        if (this.isTransportError(e)) {
          this.invalidate();
          const retry = await this.ready().catch(() => null);
          if (retry) {
            try {
              return await this.execOnce(retry, line, opts);
            } catch (e2) {
              if (this.isTransportError(e2)) throw e2;
              return { code: 1, stdout: "", stderr: String((e2 as Error).message ?? e2) };
            }
          }
        }
        throw e;
      }
    } catch (e) {
      const err = e as Error;
      return { code: null, stdout: "", stderr: err.message ?? String(e) };
    }
  }

  private execOnce(client: Ssh2Client, line: string, opts?: ExecOptions): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs ?? 20_000;
    const maxBuffer = opts?.maxBuffer ?? 4 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      client.exec(line, (err, stream) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let settled = false;
        let exitCode: number | null = null;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            stream.close();
            resolve({ code: 124, stdout, stderr: stderr || "timed out", timedOut: true });
          }
        }, timeoutMs);

        const onData = (chunk: Buffer, toStderr: boolean) => {
          const text = chunk.toString("utf8");
          if (toStderr) {
            if (stderr.length < maxBuffer) stderr += text.slice(0, maxBuffer - stderr.length);
            else truncated = true;
          } else {
            if (stdout.length < maxBuffer) stdout += text.slice(0, maxBuffer - stdout.length);
            else truncated = true;
          }
        };
        stream.on("data", (c: Buffer) => onData(c, false));
        stream.on("stderr", (c: Buffer) => onData(c, true));
        stream.on("error", (e: Error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(e);
          }
        });
        stream.on("close", (code?: number) => {
          if (exitCode === null) exitCode = code ?? null;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({
              code: exitCode,
              stdout,
              stderr: truncated ? `${stderr}\n[output truncated at ${maxBuffer} bytes]` : stderr,
            });
          }
        });
        if (opts?.input !== undefined) {
          stream.write(opts.input);
        }
        stream.end();
      });
    });
  }

  private openClient(): Promise<Ssh2Client> {
    return new Promise((resolve, reject) => {
      const client = new Client() as Ssh2Client;
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        this.scheduleBackoff(e);
        try {
          client.end();
        } catch {
          /* noop */
        }
        reject(e);
      };
      client.on("ready", () => {
        if (settled) return;
        settled = true;
        this.client = client;
        this.connected = true;
        this.resetBackoff();
        this.lastError = "";
        this.emit("connected");
        resolve(client);
      });
      client.on("error", (e: Error) => {
        this.lastError = e.message;
        this.emit("error", e);
        fail(e);
      });
      client.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (this.client === client) this.client = null;
        if (wasConnected && !this.closed) {
          this.scheduleBackoff(new Error("connection closed"));
          this.emit("disconnected");
        }
      });
      const connectOpts: Record<string, unknown> = {
        host: this.creds.host,
        port: this.creds.port,
        username: this.creds.username,
        tryKeyboard: false,
        keepaliveInterval: this.keepaliveMs,
        keepaliveCountMax: 3,
        readyTimeout: this.readyTimeoutMs,
      };
      if (this.creds.privateKey) connectOpts.privateKey = this.creds.privateKey;
      else if (this.creds.password) connectOpts.password = this.creds.password;
      client.connect(connectOpts as never);
    });
  }

  private scheduleBackoff(e: Error): void {
    this.lastError = e.message ?? String(e);
    const jitter = Math.floor(Math.random() * 500);
    this.nextAttemptAt = Date.now() + this.backoffMs + jitter;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  private resetBackoff(): void {
    this.backoffMs = 1_000;
    this.nextAttemptAt = 0;
  }

  private isTransportError(e: unknown): boolean {
    const err = e as NodeJS.ErrnoException;
    const msg = String(err?.message ?? e).toLowerCase();
    return (
      /channel|socket|closed|no connection|packet/.test(msg) ||
      String(err?.code ?? "").startsWith("ECONN")
    );
  }

  /** Force the next ready() to reconnect (e.g. after an exec saw a dead channel). */
  invalidate(): void {
    this.connected = false;
    const c = this.client;
    this.client = null;
    try {
      c?.end();
    } catch {
      /* noop */
    }
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    try {
      this.client?.end();
    } catch {
      /* noop */
    }
    this.client = null;
    this.emit("disconnected");
  }
}

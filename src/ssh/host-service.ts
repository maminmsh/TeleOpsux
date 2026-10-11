import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "ssh2";
import type { DB } from "../db/database";
import type { SshHost } from "../shared/types";
import type { SshHostCredentials } from "./ssh-connection";

/**
 * Passwords are encrypted with AES-256-GCM at rest. The key lives in a
 * 0600-mode file next to the database. Honest caveat: this protects against
 * DB dumps/backups, NOT against someone with shell access to the TeleOps box.
 */
export class HostService {
  private key: Buffer | null = null;

  constructor(
    private db: DB,
    private keyFile: string,
  ) {}

  addHost(input: {
    host: string;
    port: number;
    username: string;
    password: string;
    name?: string;
    activate?: boolean;
  }): SshHost {
    const name = input.name?.trim() || input.host;
    // Re-adding the same display name updates the row in place: projects keep
    // their host_id FK and the active flag survives.
    const existing = this.db.listHosts().find((h) => h.name === name);
    if (existing) {
      this.db.updateHost(existing.id, {
        host: input.host,
        port: input.port,
        username: input.username,
        password_enc: this.encrypt(input.password),
      });
      const host = this.db.getHost(existing.id)!;
      if (input.activate) this.db.setActiveHost(host.id);
      return host;
    }
    const host = this.db.createHost({
      name,
      host: input.host,
      port: input.port,
      username: input.username,
      password_enc: this.encrypt(input.password),
    });
    if (input.activate) this.db.setActiveHost(host.id);
    return host;
  }

  activateHost(id: number): void {
    this.db.setActiveHost(id);
  }

  getHost(id: number): SshHost | undefined {
    return this.db.getHost(id);
  }

  getActiveHost(): SshHost | undefined {
    return this.db.getActiveHost();
  }

  getCredentials(host: SshHost): SshHostCredentials {
    return {
      host: host.host,
      port: host.port,
      username: host.username,
      password: this.decrypt(host.password_enc),
    };
  }

  deleteHost(id: number): void {
    this.db.deleteHost(id);
  }

  /** One-shot connection test (does not touch the pooled connection). */
  testConnection(creds: SshHostCredentials): Promise<{
    ok: boolean;
    error?: string;
    hostname?: string;
    user?: string;
    tmux?: string | null;
  }> {
    return new Promise((resolve) => {
      const conn = new Client();
      let done = false;
      const finish = (r: { ok: boolean; error?: string; hostname?: string; user?: string; tmux?: string | null }) => {
        if (done) return;
        done = true;
        try {
          conn.end();
        } catch {
          /* noop */
        }
        resolve(r);
      };
      conn.on("error", (e) => finish({ ok: false, error: e.message }));
      conn.on("ready", () => {
        const collect = (
          line: string,
          cb: (out: string, err: string) => void,
        ) => {
          conn.exec(line, (err, stream) => {
            if (err) return cb("", err.message);
            let out = "";
            let serr = "";
            stream.on("data", (c: Buffer) => (out += c));
            stream.on("stderr", (c: Buffer) => (serr += c));
            stream.on("close", () => cb(out, serr));
          });
        };
        collect("hostname; whoami; tmux -V 2>/dev/null || echo NO_TMUX", (out, err) => {
          if (err && !out) return finish({ ok: false, error: err });
          const [hostname, user, tmuxLine] = out.trim().split(/\r?\n/);
          finish({
            ok: true,
            hostname: hostname?.trim(),
            user: user?.trim(),
            tmux: tmuxLine === "NO_TMUX" ? null : tmuxLine?.trim(),
          });
        });
      });
      conn.connect({
        host: creds.host,
        port: creds.port,
        username: creds.username,
        password: creds.password,
        tryKeyboard: false,
        readyTimeout: 15_000,
      });
    });
  }

  // ---- crypto ----
  private loadKey(): Buffer {
    if (this.key) return this.key;
    if (fs.existsSync(this.keyFile)) {
      this.key = Buffer.from(fs.readFileSync(this.keyFile, "utf8").trim(), "hex");
      if (this.key.length !== 32) throw new Error(`${this.keyFile} is not a 32-byte hex key`);
    } else {
      this.key = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(path.resolve(this.keyFile)), { recursive: true });
      fs.writeFileSync(this.keyFile, this.key.toString("hex"), { mode: 0o600 });
    }
    return this.key;
  }

  private encrypt(plain: string): string {
    const key = this.loadKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
  }

  private decrypt(blob: string): string {
    const key = this.loadKey();
    const [ivB64, tagB64, dataB64] = blob.split(":");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("corrupted password_enc field");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  }
}

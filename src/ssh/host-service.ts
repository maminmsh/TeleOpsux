import { Client } from "ssh2";
import type { DB } from "../db/database";
import type { SshHost } from "../shared/types";
import type { SshHostCredentials } from "./ssh-connection";
import type { Config } from "../config/config";
import { SecretBox } from "../shared/secret-box";
import { isAdminUser } from "../auth/access";

/**
 * Passwords are encrypted with AES-256-GCM at rest. The key lives in a
 * 0600-mode file next to the database. Honest caveat: this protects against
 * DB dumps/backups, NOT against someone with shell access to the TeleOps box.
 */
export class HostService {
  constructor(
    private db: DB,
    private keyFile: string,
    /** When provided, activation is admin-gated per user. Without it every activation is global (legacy). */
    private config?: Config,
  ) {}

  addHost(input: {
    host: string;
    port: number;
    username: string;
    password?: string;
    auth_type?: "password" | "key";
    private_key?: string;
    name?: string;
    activate?: boolean;
    /** Owning Telegram user; normal users only ever see/manage their own hosts. */
    owner?: number | null;
  }): SshHost {
    const owner = input.owner ?? null;
    const baseName = input.name?.trim() || input.host;
    // Names are globally unique; per-owner disambiguation keeps two users from
    // silently overwriting each other's host row.
    const taken = new Set(this.db.listHosts().map((h) => h.name));
    let name = baseName;
    const sameOwnerRow = this.db.listHosts().find((h) => h.name === baseName);
    if (taken.has(name) && sameOwnerRow && sameOwnerRow.owner_telegram_user_id !== owner) {
      for (let i = 2; taken.has(name); i++) name = `${baseName}-${i}`;
    }
    const authType = input.auth_type ?? (input.private_key ? "key" : "password");
    const passwordEnc = input.password ? this.encrypt(input.password) : "";
    const privateKeyEnc = input.private_key ? this.encrypt(input.private_key) : null;

    // Re-adding the same display name updates the row in place: projects keep
    // their host_id FK and the active flag survives.
    const existing = this.db.listHosts().find((h) => h.name === name);
    if (existing) {
      this.db.updateHost(existing.id, {
        host: input.host,
        port: input.port,
        username: input.username,
        password_enc: passwordEnc,
        auth_type: authType,
        private_key_enc: privateKeyEnc,
      });
      const host = this.db.getHost(existing.id)!;
      if (input.activate) this.activate(owner, host.id);
      return host;
    }
    const host = this.db.createHost({
      name,
      host: input.host,
      port: input.port,
      username: input.username,
      password_enc: passwordEnc,
      auth_type: authType,
      private_key_enc: privateKeyEnc,
      owner_telegram_user_id: owner,
    });
    if (input.activate) this.activate(owner, host.id);
    return host;
  }

  /**
   * Make a host the user's working server. Admins also flip the GLOBAL active
   * host (which the SSH transport follows); normal users only update their own
   * per-user pointer, so one user's switch never moves another user's target.
   */
  private activate(owner: number | null, hostId: number): void {
    // A normal user never STEALS the global transport from an existing active
    // host; but if nothing is connected yet, their host becomes the working
    // transport so single-user deployments keep working out of the box.
    if (this.isGlobalAdmin(owner) || !this.db.getActiveHost()) this.db.setActiveHost(hostId);
    if (owner !== null) this.db.setUserActiveHost(owner, hostId);
  }

  private isGlobalAdmin(owner: number | null): boolean {
    if (!this.config) return true; // legacy: single-operator deployments
    if (owner === null) return true;
    return isAdminUser({ config: this.config }, owner);
  }

  activateHost(id: number): void {
    this.db.setActiveHost(id);
  }

  activateHostForUser(telegramUserId: number, hostId: number): void {
    if (!this.db.getHost(hostId)) return;
    const global = this.db.getActiveHost();
    if (
      this.isGlobalAdmin(telegramUserId) ||
      !global ||
      global.owner_telegram_user_id === telegramUserId
    )
      this.db.setActiveHost(hostId);
    this.db.setUserActiveHost(telegramUserId, hostId);
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
      password: host.password_enc ? this.decrypt(host.password_enc) : undefined,
      privateKey: host.private_key_enc ? this.decrypt(host.private_key_enc) : undefined,
    };
  }

  deleteHost(id: number): void {
    this.db.deleteHost(id);
  }

  /** Test a host by id and update its last_connected_at / last_error columns in DB. */
  async testHost(id: number): Promise<{
    ok: boolean;
    error?: string;
    hostname?: string;
    user?: string;
    tmux?: string | null;
  }> {
    const host = this.getHost(id);
    if (!host) return { ok: false, error: "Host not found" };
    const creds = this.getCredentials(host);
    const res = await this.testConnection(creds);
    if (res.ok) {
      this.db.updateHost(id, {
        last_connected_at: new Date().toISOString(),
        last_error: null,
      });
    } else {
      this.db.updateHost(id, {
        last_error: res.error ?? "Connection failed",
      });
    }
    return res;
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
      const connectOpts: Record<string, unknown> = {
        host: creds.host,
        port: creds.port,
        username: creds.username,
        tryKeyboard: false,
        readyTimeout: 15_000,
      };
      if (creds.privateKey) connectOpts.privateKey = creds.privateKey;
      else if (creds.password) connectOpts.password = creds.password;
      conn.connect(connectOpts as never);
    });
  }

  // ---- crypto ---- (shared SecretBox; format identical to pre-refactor blobs)
  private get box(): SecretBox {
    return (this._box ??= new SecretBox(this.keyFile));
  }
  private _box: SecretBox | null = null;

  private encrypt(plain: string): string {
    return this.box.encrypt(plain);
  }

  private decrypt(blob: string): string {
    return this.box.decrypt(blob);
  }
}
